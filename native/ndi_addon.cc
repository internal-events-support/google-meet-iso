// Google Meet ISO native NDI sender addon (N-API, ABI-stable across Electron versions).
//
// Design:
//  - The NDI runtime is loaded dynamically (NDIlib_v6_load) from NDI_RUNTIME_DIR_V6,
//    so we never link against the SDK import lib and work with the installed runtime.
//  - Each Sender owns one NDI send instance plus a worker thread. JS hands frames in
//    via sendVideo(); we memcpy into a pending slot (latest frame wins, older ones are
//    dropped) and the worker does the actual (blocking, compressing) NDI send. This
//    keeps the renderer's main thread free.
//  - If no frame arrives for `idleMs` the worker emits a black slate at ~5 fps so
//    downstream switchers keep a stable source instead of a frozen last frame.
//  - Cadence clock (setCadence(fpsN, fpsD)): the worker sends at exactly fpsN/fpsD on a
//    high-resolution timer, using the latest submitted frame and repeating the previous
//    one when JS had nothing new. JS then only submits when content actually changed.
//    Only the worker thread ever calls send_send_video_v2 for an instance.

#include <napi.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include "Processing.NDI.Lib.h"

namespace {

const NDIlib_v6* g_ndi = nullptr;
std::string g_loadError;
std::string g_loadedFrom;

bool LoadNdi() {
  if (g_ndi) return true;
  std::vector<std::string> candidates;
  if (const char* dir = std::getenv(NDILIB_REDIST_FOLDER)) {
    std::string p = dir;
#ifdef _WIN32
    p += "\\";
#else
    if (!p.empty() && p.back() != '/') p += "/";
#endif
    p += NDILIB_LIBRARY_NAME;
    candidates.push_back(p);
  }
  candidates.push_back(NDILIB_LIBRARY_NAME);  // PATH / next to the app

  for (const auto& path : candidates) {
    const NDIlib_v6* (*loader)(void) = nullptr;
#ifdef _WIN32
    HMODULE h = LoadLibraryA(path.c_str());
    if (!h) continue;
    *reinterpret_cast<FARPROC*>(&loader) = GetProcAddress(h, "NDIlib_v6_load");
    if (!loader) { FreeLibrary(h); continue; }
#else
    void* h = dlopen(path.c_str(), RTLD_LOCAL | RTLD_LAZY);
    if (!h) continue;
    *reinterpret_cast<void**>(&loader) = dlsym(h, "NDIlib_v6_load");
    if (!loader) { dlclose(h); continue; }
#endif
    const NDIlib_v6* lib = loader();
    if (!lib) continue;
    if (!lib->initialize()) {
      g_loadError = "NDI initialize() failed (CPU not supported?)";
      return false;
    }
    g_ndi = lib;
    g_loadedFrom = path;
    return true;
  }
  g_loadError = std::string("Could not load ") + NDILIB_LIBRARY_NAME +
                " — is the NDI 6 Runtime installed? (" + NDILIB_REDIST_URL + ")";
  return false;
}

bool ParseFourCC(const std::string& s, NDIlib_FourCC_video_type_e* out, int* bppNum, int* bppDen) {
  // bytes-per-pixel as a fraction, used to validate buffer sizes.
  if (s == "I420") { *out = NDIlib_FourCC_video_type_I420; *bppNum = 3; *bppDen = 2; return true; }
  if (s == "NV12") { *out = NDIlib_FourCC_video_type_NV12; *bppNum = 3; *bppDen = 2; return true; }
  if (s == "BGRA") { *out = NDIlib_FourCC_video_type_BGRA; *bppNum = 4; *bppDen = 1; return true; }
  if (s == "BGRX") { *out = NDIlib_FourCC_video_type_BGRX; *bppNum = 4; *bppDen = 1; return true; }
  if (s == "RGBA") { *out = NDIlib_FourCC_video_type_RGBA; *bppNum = 4; *bppDen = 1; return true; }
  if (s == "RGBX") { *out = NDIlib_FourCC_video_type_RGBX; *bppNum = 4; *bppDen = 1; return true; }
  if (s == "UYVY") { *out = NDIlib_FourCC_video_type_UYVY; *bppNum = 2; *bppDen = 1; return true; }
  if (s == "UYVA") { *out = NDIlib_FourCC_video_type_UYVA; *bppNum = 3; *bppDen = 1; return true; }
  return false;
}

// Bytes needed for a frame: planar 4:2:0 (stride = luma stride), UYVA (UYVY plane of
// `stride` bytes/row followed by a w*h alpha plane), else packed rows of `stride` bytes.
size_t FrameBytes(NDIlib_FourCC_video_type_e fourcc, int w, int h, int stride) {
  if (fourcc == NDIlib_FourCC_video_type_I420 || fourcc == NDIlib_FourCC_video_type_NV12)
    return static_cast<size_t>(stride) * h * 3 / 2;
  if (fourcc == NDIlib_FourCC_video_type_UYVA) return static_cast<size_t>(stride) * h + static_cast<size_t>(w) * h;
  return static_cast<size_t>(stride) * h;
}

int DefaultStride(NDIlib_FourCC_video_type_e fourcc, int w) {
  switch (fourcc) {
    case NDIlib_FourCC_video_type_I420:
    case NDIlib_FourCC_video_type_NV12: return w;
    case NDIlib_FourCC_video_type_UYVY:
    case NDIlib_FourCC_video_type_UYVA: return w * 2;
    default: return w * 4;
  }
}

#ifdef _WIN32
// Per-thread high-resolution waitable timer (Win10 1803+), falling back to a normal one.
struct PreciseTimer {
  HANDLE h = nullptr;
  PreciseTimer() {
    h = CreateWaitableTimerExW(nullptr, nullptr, 0x00000002 /*CREATE_WAITABLE_TIMER_HIGH_RESOLUTION*/, TIMER_ALL_ACCESS);
    if (!h) h = CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS);
  }
  ~PreciseTimer() { if (h) CloseHandle(h); }
  void SleepUntil(std::chrono::steady_clock::time_point t) {
    auto d = t - std::chrono::steady_clock::now();
    if (d <= std::chrono::steady_clock::duration::zero()) return;
    auto us = std::chrono::duration_cast<std::chrono::microseconds>(d).count();
    if (!h) { std::this_thread::sleep_until(t); return; }
    LARGE_INTEGER due;
    due.QuadPart = -static_cast<LONGLONG>(us * 10);  // relative, 100 ns units
    if (SetWaitableTimerEx(h, &due, 0, nullptr, nullptr, nullptr, 0)) WaitForSingleObject(h, INFINITE);
    else std::this_thread::sleep_until(t);
  }
};
#else
struct PreciseTimer {
  void SleepUntil(std::chrono::steady_clock::time_point t) { std::this_thread::sleep_until(t); }
};
#endif

struct Frame {
  std::vector<uint8_t> data;
  int width = 0;
  int height = 0;
  int stride = 0;
  NDIlib_FourCC_video_type_e fourcc = NDIlib_FourCC_video_type_I420;
};

class Sender : public Napi::ObjectWrap<Sender> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Sender", {
      InstanceMethod("sendVideo", &Sender::SendVideo),
      InstanceMethod("sendAudio", &Sender::SendAudio),
      InstanceMethod("setCadence", &Sender::SetCadence),
      InstanceMethod("connections", &Sender::Connections),
      InstanceMethod("stats", &Sender::Stats),
      InstanceMethod("destroy", &Sender::Destroy),
    });
  }

  // new Sender(name: string, opts?: { idleMs?: number, slateWidth?: number, slateHeight?: number, groups?: string })
  explicit Sender(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Sender>(info) {
    Napi::Env env = info.Env();
    if (!LoadNdi()) {
      Napi::Error::New(env, g_loadError).ThrowAsJavaScriptException();
      return;
    }
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "Sender(name: string, opts?)").ThrowAsJavaScriptException();
      return;
    }
    name_ = info[0].As<Napi::String>().Utf8Value();
    if (info.Length() > 1 && info[1].IsObject()) {
      auto o = info[1].As<Napi::Object>();
      if (o.Has("idleMs")) idleMs_ = o.Get("idleMs").As<Napi::Number>().Int32Value();
      if (o.Has("slateWidth")) slateW_ = o.Get("slateWidth").As<Napi::Number>().Int32Value();
      if (o.Has("slateHeight")) slateH_ = o.Get("slateHeight").As<Napi::Number>().Int32Value();
      if (o.Has("groups") && o.Get("groups").IsString()) groups_ = o.Get("groups").As<Napi::String>().Utf8Value();
    }

    NDIlib_send_create_t create{};
    create.p_ndi_name = name_.c_str();
    create.p_groups = groups_.empty() ? nullptr : groups_.c_str();
    create.clock_video = false;  // frames arrive at network pace; don't let NDI block us
    create.clock_audio = false;
    send_ = g_ndi->send_create(&create);
    if (!send_) {
      Napi::Error::New(env, "NDI send_create failed for '" + name_ + "'").ThrowAsJavaScriptException();
      return;
    }
    BuildSlate();
    running_ = true;
    lastFrameAt_ = std::chrono::steady_clock::now() - std::chrono::hours(1);
    worker_ = std::thread([this] { Run(); });
  }

  ~Sender() override { Shutdown(); }

 private:
  // sendAudio(planar: Float32Array (ch0 samples, ch1 samples, ...), sampleRate, channels, samplesPerChannel)
  Napi::Value SendAudio(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!send_ || info.Length() < 4 || !info[0].IsTypedArray()) return Napi::Boolean::New(env, false);
    auto ta = info[0].As<Napi::Float32Array>();
    int sr = info[1].As<Napi::Number>().Int32Value();
    int ch = info[2].As<Napi::Number>().Int32Value();
    int ns = info[3].As<Napi::Number>().Int32Value();
    if (ch <= 0 || ns <= 0 || ta.ElementLength() < static_cast<size_t>(ch) * ns) return Napi::Boolean::New(env, false);
    NDIlib_audio_frame_v3_t a{};
    a.sample_rate = sr;
    a.no_channels = ch;
    a.no_samples = ns;
    a.timecode = NDIlib_send_timecode_synthesize;
    a.FourCC = NDIlib_FourCC_audio_type_FLTP;
    a.p_data = reinterpret_cast<uint8_t*>(ta.Data());
    a.channel_stride_in_bytes = ns * 4;
    g_ndi->send_send_audio_v3(send_, &a);  // NDI allows audio + video sends concurrently
    return Napi::Boolean::New(env, true);
  }

  // setCadence(fpsN, fpsD): fpsN > 0 starts the clocked mode (send the latest frame, or
  // repeat the previous one, exactly every fpsD/fpsN s); 0 returns to send-on-submit.
  Napi::Value SetCadence(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    int n = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Int32Value() : 0;
    int d = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().Int32Value() : 1;
    {
      std::lock_guard<std::mutex> lk(mu_);
      if (n > 0 && d > 0) {
        clockN_ = n;
        clockD_ = d;
        fpsN_ = n;
        fpsD_ = d;
      } else {
        clockN_ = 0;
        clockD_ = 0;
      }
      clockChanged_ = true;
    }
    cv_.notify_one();
    return Napi::Boolean::New(env, true);
  }

  // sendVideo(data: ArrayBuffer | TypedArray, width, height, format: 'I420'|'NV12'|'UYVY'|'UYVA'|'BGRA'|...,
  //           stride?: number, fpsN?: number, fpsD?: number)
  // In clocked mode (setCadence) this only submits the frame; the worker sends it on the next tick.
  // For planar formats the buffer must be tightly packed planes (Y, then U, then V / UV)
  // with luma stride = `stride` (default: width) and chroma stride = stride/2 (I420) or stride (NV12).
  Napi::Value SendVideo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!send_) return Napi::Boolean::New(env, false);
    if (info.Length() < 4) {
      Napi::TypeError::New(env, "sendVideo(data, width, height, format, stride?)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const uint8_t* ptr = nullptr;
    size_t len = 0;
    if (info[0].IsArrayBuffer()) {
      auto ab = info[0].As<Napi::ArrayBuffer>();
      ptr = static_cast<const uint8_t*>(ab.Data());
      len = ab.ByteLength();
    } else if (info[0].IsTypedArray()) {
      auto ta = info[0].As<Napi::TypedArray>();
      auto ab = ta.ArrayBuffer();
      ptr = static_cast<const uint8_t*>(ab.Data()) + ta.ByteOffset();
      len = ta.ByteLength();
    } else {
      Napi::TypeError::New(env, "data must be ArrayBuffer or TypedArray").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();
    std::string fmt = info[3].As<Napi::String>().Utf8Value();
    NDIlib_FourCC_video_type_e fourcc;
    int bn, bd;
    if (!ParseFourCC(fmt, &fourcc, &bn, &bd)) {
      Napi::TypeError::New(env, "unsupported format " + fmt).ThrowAsJavaScriptException();
      return env.Undefined();
    }
    (void)bn; (void)bd;
    int stride = (info.Length() > 4 && info[4].IsNumber()) ? info[4].As<Napi::Number>().Int32Value()
                                                          : DefaultStride(fourcc, w);
    size_t need = FrameBytes(fourcc, w, h, stride);
    if (w <= 0 || h <= 0 || len < need) {
      Napi::RangeError::New(env, "buffer too small for frame").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    {
      std::lock_guard<std::mutex> lk(mu_);
      if (hasPending_) dropped_++;
      pending_.data.resize(need);
      std::memcpy(pending_.data.data(), ptr, need);
      pending_.width = w;
      pending_.height = h;
      pending_.stride = stride;
      pending_.fourcc = fourcc;
      if (clockN_ == 0 && info.Length() > 6 && info[5].IsNumber() && info[6].IsNumber()) {
        fpsN_ = info[5].As<Napi::Number>().Int32Value();
        fpsD_ = info[6].As<Napi::Number>().Int32Value();
      }
      hasPending_ = true;
      received_++;
    }
    cv_.notify_one();
    return Napi::Boolean::New(env, true);
  }

  Napi::Value Connections(const Napi::CallbackInfo& info) {
    if (!send_) return Napi::Number::New(info.Env(), 0);
    return Napi::Number::New(info.Env(), g_ndi->send_get_no_connections(send_, 0));
  }

  Napi::Value Stats(const Napi::CallbackInfo& info) {
    auto o = Napi::Object::New(info.Env());
    o.Set("name", name_);
    o.Set("received", static_cast<double>(received_.load()));
    o.Set("sent", static_cast<double>(sent_.load()));
    o.Set("dropped", static_cast<double>(dropped_.load()));
    o.Set("repeated", static_cast<double>(repeated_.load()));
    o.Set("late", static_cast<double>(late_.load()));
    o.Set("clocked", clockN_ != 0);
    o.Set("slate", slating_.load());
    o.Set("width", lastW_.load());
    o.Set("height", lastH_.load());
    o.Set("connections", send_ ? g_ndi->send_get_no_connections(send_, 0) : 0);
    // Tally from downstream switchers (vMix/OBS/TriCaster...): is this source on program/preview?
    NDIlib_tally_t tally{};
    if (send_) g_ndi->send_get_tally(send_, &tally, 0);
    o.Set("program", tally.on_program);
    o.Set("preview", tally.on_preview);
    return o;
  }

  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    Shutdown();
    return info.Env().Undefined();
  }

  void Shutdown() {
    if (running_.exchange(false)) {
      cv_.notify_all();
      if (worker_.joinable()) worker_.join();
    }
    if (send_) {
      g_ndi->send_destroy(send_);
      send_ = nullptr;
    }
  }

  void BuildSlate() {
    // Black in UYVY: U=128 Y=16 V=128 Y=16
    slateW_ = (slateW_ > 0 ? slateW_ : 1280) & ~1;
    slateH_ = slateH_ > 0 ? slateH_ : 720;
    slate_.resize(static_cast<size_t>(slateW_) * 2 * slateH_);
    for (size_t i = 0; i < slate_.size(); i += 4) {
      slate_[i] = 128; slate_[i + 1] = 16; slate_[i + 2] = 128; slate_[i + 3] = 16;
    }
  }

  void Emit(const uint8_t* data, int w, int h, int stride, NDIlib_FourCC_video_type_e fourcc) {
    NDIlib_video_frame_v2_t f{};
    f.xres = w;
    f.yres = h;
    f.FourCC = fourcc;
    const int fn = fpsN_.load(), fd = fpsD_.load();
    f.frame_rate_N = fn > 0 ? fn : 30000;
    f.frame_rate_D = fd > 0 ? fd : 1001;
    f.picture_aspect_ratio = 0.0f;  // square pixels
    f.frame_format_type = NDIlib_frame_format_type_progressive;
    f.timecode = NDIlib_send_timecode_synthesize;
    f.p_data = const_cast<uint8_t*>(data);
    f.line_stride_in_bytes = stride;
    g_ndi->send_send_video_v2(send_, &f);  // synchronous: buffer may be reused after return
  }

  // Clocked mode: one send per tick at fpsN/fpsD; returns when the cadence is turned off.
  void RunClocked() {
    using namespace std::chrono;
    PreciseTimer timer;
    int n = 0, d = 1;
    steady_clock::time_point start;
    int64_t tick = 0;
    bool haveCur = false;
    while (running_) {
      {
        std::unique_lock<std::mutex> lk(mu_);
        if (clockN_ == 0) return;
        if (clockChanged_ || n == 0) {
          clockChanged_ = false;
          n = clockN_;
          d = clockD_;
          start = steady_clock::now();
          tick = 0;
        }
        if (hasPending_) {
          std::swap(current_, pending_);
          hasPending_ = false;
          haveCur = true;
          sentNew_ = true;
        }
      }
      if (haveCur && !current_.data.empty()) {
        Emit(current_.data.data(), current_.width, current_.height, current_.stride, current_.fourcc);
        lastW_ = current_.width;
        lastH_ = current_.height;
        slating_ = false;
        sent_++;
        if (!sentNew_) repeated_++;
        sentNew_ = false;
      }
      tick++;
      // Deadline of the next tick, computed from the start to avoid drift (integer ns).
      auto due = start + nanoseconds(static_cast<int64_t>(tick * 1000000000LL * d / n));
      auto now = steady_clock::now();
      if (now > due + nanoseconds(1000000000LL * d / n * 4)) {
        // Far behind (suspend/hiccup): resync rather than bursting.
        late_++;
        start = now;
        tick = 0;
        continue;
      }
      if (now > due) { late_++; continue; }
      timer.SleepUntil(due);
    }
  }

  void Run() {
    using namespace std::chrono;
    Frame work;
    auto lastSlate = steady_clock::now() - hours(1);
    while (running_) {
      bool have = false;
      bool clocked = false;
      {
        std::unique_lock<std::mutex> lk(mu_);
        clocked = clockN_ != 0;
      }
      if (clocked) {
        RunClocked();
        lastFrameAt_ = steady_clock::now();
        continue;
      }
      {
        std::unique_lock<std::mutex> lk(mu_);
        cv_.wait_for(lk, milliseconds(100), [this] { return hasPending_ || !running_ || clockN_ != 0; });
        if (clockN_ != 0) continue;
        if (!running_) break;
        if (hasPending_) {
          std::swap(work, pending_);
          hasPending_ = false;
          have = true;
        }
      }
      auto now = steady_clock::now();
      if (have) {
        Emit(work.data.data(), work.width, work.height, work.stride, work.fourcc);
        lastFrameAt_ = now;
        lastW_ = work.width;
        lastH_ = work.height;
        slating_ = false;
        sent_++;
      } else if (idleMs_ > 0 && now - lastFrameAt_ > milliseconds(idleMs_) && now - lastSlate > milliseconds(200)) {
        Emit(slate_.data(), slateW_, slateH_, slateW_ * 2, NDIlib_FourCC_video_type_UYVY);
        lastSlate = now;
        slating_ = true;
      }
    }
  }

  std::string name_;
  std::string groups_;
  NDIlib_send_instance_t send_ = nullptr;
  int idleMs_ = 1000;  // <= 0 disables the automatic black slate (JS renders loss modes)
  std::atomic<int> fpsN_{0}, fpsD_{0};
  int slateW_ = 1280;
  int slateH_ = 720;
  std::vector<uint8_t> slate_;

  std::thread worker_;
  std::atomic<bool> running_{false};
  std::mutex mu_;
  std::condition_variable cv_;
  Frame pending_;
  Frame current_;  // worker-only: the frame repeated by the cadence clock
  bool hasPending_ = false;
  int clockN_ = 0, clockD_ = 0;  // guarded by mu_
  bool clockChanged_ = false;
  bool sentNew_ = false;
  std::chrono::steady_clock::time_point lastFrameAt_;

  std::atomic<uint64_t> received_{0}, sent_{0}, dropped_{0}, repeated_{0}, late_{0};
  std::atomic<int> lastW_{0}, lastH_{0};
  std::atomic<bool> slating_{false};
};

Napi::Value Load(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto o = Napi::Object::New(env);
  bool ok = LoadNdi();
  o.Set("ok", ok);
  if (ok) {
    o.Set("version", g_ndi->version());
    o.Set("path", g_loadedFrom);
  } else {
    o.Set("error", g_loadError);
  }
  return o;
}

// --- Diagnostics: discovery + single-frame receive (blocking; for tests/tools only) ---

// findSources(timeoutMs = 2000): string[]
Napi::Value FindSources(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!LoadNdi()) { Napi::Error::New(env, g_loadError).ThrowAsJavaScriptException(); return env.Undefined(); }
  uint32_t timeout = info.Length() > 0 && info[0].IsNumber() ? info[0].As<Napi::Number>().Uint32Value() : 2000;
  NDIlib_find_create_t fc{};
  fc.show_local_sources = true;
  NDIlib_find_instance_t f = g_ndi->find_create_v2(&fc);
  auto start = std::chrono::steady_clock::now();
  while (std::chrono::steady_clock::now() - start < std::chrono::milliseconds(timeout))
    g_ndi->find_wait_for_sources(f, 200);
  uint32_t n = 0;
  const NDIlib_source_t* srcs = g_ndi->find_get_current_sources(f, &n);
  auto arr = Napi::Array::New(env, n);
  for (uint32_t i = 0; i < n; i++) arr.Set(i, srcs[i].p_ndi_name);
  g_ndi->find_destroy(f);
  return arr;
}

// receiveFrame(fullSourceName, timeoutMs = 5000): { width, height, fourcc, avgLuma } | null
Napi::Value ReceiveFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!LoadNdi()) { Napi::Error::New(env, g_loadError).ThrowAsJavaScriptException(); return env.Undefined(); }
  std::string name = info[0].As<Napi::String>().Utf8Value();
  uint32_t timeout = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().Uint32Value() : 5000;
  NDIlib_source_t src{};
  src.p_ndi_name = name.c_str();
  NDIlib_recv_create_v3_t rc{};
  rc.source_to_connect_to = src;
  rc.color_format = NDIlib_recv_color_format_UYVY_BGRA;
  rc.bandwidth = NDIlib_recv_bandwidth_highest;
  NDIlib_recv_instance_t r = g_ndi->recv_create_v3(&rc);
  if (!r) return env.Null();
  Napi::Value result = env.Null();
  auto start = std::chrono::steady_clock::now();
  while (std::chrono::steady_clock::now() - start < std::chrono::milliseconds(timeout)) {
    NDIlib_video_frame_v2_t v{};
    auto t = g_ndi->recv_capture_v2(r, &v, nullptr, nullptr, 200);
    if (t != NDIlib_frame_type_video) continue;
    auto o = Napi::Object::New(env);
    o.Set("width", v.xres);
    o.Set("height", v.yres);
    char cc[5] = {static_cast<char>(v.FourCC & 0xff), static_cast<char>((v.FourCC >> 8) & 0xff),
                  static_cast<char>((v.FourCC >> 16) & 0xff), static_cast<char>((v.FourCC >> 24) & 0xff), 0};
    o.Set("fourcc", std::string(cc));
    // Average of a sample of bytes in the middle row: a cheap "is this not black" signal.
    if (v.FourCC == NDIlib_FourCC_video_type_UYVY) {
      const uint8_t* row = v.p_data + static_cast<size_t>(v.line_stride_in_bytes) * (v.yres / 2);
      uint64_t sum = 0; int cnt = 0;
      for (int x = 1; x < v.xres * 2; x += 2) { sum += row[x]; cnt++; }
      o.Set("avgLuma", cnt ? static_cast<double>(sum) / cnt : 0.0);
    } else if (v.FourCC == NDIlib_FourCC_video_type_BGRA || v.FourCC == NDIlib_FourCC_video_type_BGRX) {
      const uint8_t* row = v.p_data + static_cast<size_t>(v.line_stride_in_bytes) * (v.yres / 2);
      double sum = 0;
      for (int x = 0; x < v.xres; x++) sum += 0.114 * row[x * 4] + 0.587 * row[x * 4 + 1] + 0.299 * row[x * 4 + 2];
      o.Set("avgLuma", v.xres ? sum / v.xres : 0.0);
    }
    g_ndi->recv_free_video_v2(r, &v);
    result = o;
    break;
  }
  g_ndi->recv_destroy(r);
  return result;
}

// --- Finder: non-blocking NDI source discovery (keeps running in the background) ---
class Finder : public Napi::ObjectWrap<Finder> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Finder", {
      InstanceMethod("sources", &Finder::Sources),
      InstanceMethod("destroy", &Finder::Destroy),
    });
  }
  explicit Finder(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Finder>(info) {
    if (!LoadNdi()) { Napi::Error::New(info.Env(), g_loadError).ThrowAsJavaScriptException(); return; }
    NDIlib_find_create_t fc{};
    fc.show_local_sources = true;
    find_ = g_ndi->find_create_v2(&fc);
  }
  ~Finder() override { if (find_) g_ndi->find_destroy(find_); }

 private:
  Napi::Value Sources(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!find_) return Napi::Array::New(env, 0);
    uint32_t n = 0;
    const NDIlib_source_t* srcs = g_ndi->find_get_current_sources(find_, &n);
    auto arr = Napi::Array::New(env, n);
    for (uint32_t i = 0; i < n; i++) arr.Set(i, srcs[i].p_ndi_name);
    return arr;
  }
  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    if (find_) { g_ndi->find_destroy(find_); find_ = nullptr; }
    return info.Env().Undefined();
  }
  NDIlib_find_instance_t find_ = nullptr;
};

// --- Receiver: background thread pulls video from one NDI source as BGRA/BGRX;
// JS polls read() for the latest frame (returns null if nothing new). ---
class Receiver : public Napi::ObjectWrap<Receiver> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Receiver", {
      InstanceMethod("read", &Receiver::Read),
      InstanceMethod("stats", &Receiver::Stats),
      InstanceMethod("setTally", &Receiver::SetTally),
      InstanceMethod("destroy", &Receiver::Destroy),
    });
  }
  // new Receiver(fullSourceName, { lowBandwidth?: boolean })
  explicit Receiver(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Receiver>(info) {
    Napi::Env env = info.Env();
    if (!LoadNdi()) { Napi::Error::New(env, g_loadError).ThrowAsJavaScriptException(); return; }
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "Receiver(sourceName)").ThrowAsJavaScriptException();
      return;
    }
    name_ = info[0].As<Napi::String>().Utf8Value();
    bool low = false;
    if (info.Length() > 1 && info[1].IsObject()) {
      auto o = info[1].As<Napi::Object>();
      if (o.Has("lowBandwidth")) low = o.Get("lowBandwidth").ToBoolean();
    }
    NDIlib_source_t src{};
    src.p_ndi_name = name_.c_str();
    NDIlib_recv_create_v3_t rc{};
    rc.source_to_connect_to = src;
    rc.color_format = NDIlib_recv_color_format_BGRX_BGRA;
    rc.bandwidth = low ? NDIlib_recv_bandwidth_lowest : NDIlib_recv_bandwidth_highest;
    rc.allow_video_fields = false;
    rc.p_ndi_recv_name = "Google Meet ISO camera input";
    recv_ = g_ndi->recv_create_v3(&rc);
    if (!recv_) { Napi::Error::New(env, "NDI recv_create failed").ThrowAsJavaScriptException(); return; }
    running_ = true;
    worker_ = std::thread([this] { Run(); });
  }
  ~Receiver() override { Shutdown(); }

 private:
  void Run() {
    while (running_) {
      NDIlib_video_frame_v2_t v{};
      auto t = g_ndi->recv_capture_v2(recv_, &v, nullptr, nullptr, 100);
      if (t != NDIlib_frame_type_video) continue;
      {
        std::lock_guard<std::mutex> lk(mu_);
        const size_t rowBytes = static_cast<size_t>(v.xres) * 4;
        buf_.resize(rowBytes * v.yres);
        for (int y = 0; y < v.yres; y++)
          std::memcpy(buf_.data() + rowBytes * y, v.p_data + static_cast<size_t>(v.line_stride_in_bytes) * y, rowBytes);
        w_ = v.xres;
        h_ = v.yres;
        bgrx_ = v.FourCC == NDIlib_FourCC_video_type_BGRX;
        seq_++;
      }
      g_ndi->recv_free_video_v2(recv_, &v);
    }
  }
  // read(): { width, height, format: 'BGRA'|'BGRX', data: ArrayBuffer } | null
  Napi::Value Read(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lk(mu_);
    if (seq_ == readSeq_ || buf_.empty()) return env.Null();
    readSeq_ = seq_;
    auto ab = Napi::ArrayBuffer::New(env, buf_.size());
    std::memcpy(ab.Data(), buf_.data(), buf_.size());
    auto o = Napi::Object::New(env);
    o.Set("width", w_);
    o.Set("height", h_);
    o.Set("format", bgrx_ ? "BGRX" : "BGRA");
    o.Set("data", ab);
    return o;
  }
  Napi::Value Stats(const Napi::CallbackInfo& info) {
    auto o = Napi::Object::New(info.Env());
    o.Set("name", name_);
    o.Set("frames", static_cast<double>(seq_));
    o.Set("width", w_);
    o.Set("height", h_);
    o.Set("connected", recv_ ? g_ndi->recv_get_no_connections(recv_) > 0 : false);
    return o;
  }
  // setTally(onProgram, onPreview): report tally upstream like a switcher would.
  Napi::Value SetTally(const Napi::CallbackInfo& info) {
    if (!recv_) return info.Env().Undefined();
    NDIlib_tally_t t{};
    t.on_program = info.Length() > 0 && info[0].ToBoolean();
    t.on_preview = info.Length() > 1 && info[1].ToBoolean();
    g_ndi->recv_set_tally(recv_, &t);
    return info.Env().Undefined();
  }
  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    Shutdown();
    return info.Env().Undefined();
  }
  void Shutdown() {
    if (running_.exchange(false) && worker_.joinable()) worker_.join();
    if (recv_) { g_ndi->recv_destroy(recv_); recv_ = nullptr; }
  }
  std::string name_;
  NDIlib_recv_instance_t recv_ = nullptr;
  std::thread worker_;
  std::atomic<bool> running_{false};
  std::mutex mu_;
  std::vector<uint8_t> buf_;
  int w_ = 0, h_ = 0;
  bool bgrx_ = false;
  uint64_t seq_ = 0, readSeq_ = 0;
};

// receiveAudio(fullSourceName, timeoutMs = 5000): { sampleRate, channels, samples, peak } | null
Napi::Value ReceiveAudio(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!LoadNdi()) { Napi::Error::New(env, g_loadError).ThrowAsJavaScriptException(); return env.Undefined(); }
  std::string name = info[0].As<Napi::String>().Utf8Value();
  uint32_t timeout = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().Uint32Value() : 5000;
  NDIlib_source_t src{};
  src.p_ndi_name = name.c_str();
  NDIlib_recv_create_v3_t rc{};
  rc.source_to_connect_to = src;
  rc.color_format = NDIlib_recv_color_format_fastest;
  rc.bandwidth = NDIlib_recv_bandwidth_audio_only;
  NDIlib_recv_instance_t r = g_ndi->recv_create_v3(&rc);
  if (!r) return env.Null();
  Napi::Value result = env.Null();
  double peak = 0;
  int frames = 0, sr = 0, ch = 0, total = 0;
  auto start = std::chrono::steady_clock::now();
  while (std::chrono::steady_clock::now() - start < std::chrono::milliseconds(timeout)) {
    NDIlib_audio_frame_v3_t a{};
    auto t = g_ndi->recv_capture_v3(r, nullptr, &a, nullptr, 200);
    if (t != NDIlib_frame_type_audio) continue;
    sr = a.sample_rate; ch = a.no_channels; total += a.no_samples; frames++;
    if (a.FourCC == NDIlib_FourCC_audio_type_FLTP) {
      for (int c = 0; c < a.no_channels; c++) {
        const float* p = reinterpret_cast<const float*>(a.p_data + static_cast<size_t>(c) * a.channel_stride_in_bytes);
        for (int i = 0; i < a.no_samples; i++) peak = std::max(peak, static_cast<double>(std::abs(p[i])));
      }
    }
    g_ndi->recv_free_audio_v3(r, &a);
    if (frames >= 50) break;  // ~0.5 s of audio
  }
  if (frames) {
    auto o = Napi::Object::New(env);
    o.Set("sampleRate", sr);
    o.Set("channels", ch);
    o.Set("samples", total);
    o.Set("frames", frames);
    o.Set("peak", peak);
    result = o;
  }
  g_ndi->recv_destroy(r);
  return result;
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("receiveAudio", Napi::Function::New(env, ReceiveAudio));
  exports.Set("findSources", Napi::Function::New(env, FindSources));
  exports.Set("receiveFrame", Napi::Function::New(env, ReceiveFrame));
  exports.Set("Sender", Sender::Init(env));
  exports.Set("Finder", Finder::Init(env));
  exports.Set("Receiver", Receiver::Init(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(gmeet_iso_ndi, InitModule)
