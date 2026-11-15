// gmeet-iso native NDI sender addon (N-API, ABI-stable across Electron versions).
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

#include <napi.h>

#include <atomic>
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
  return false;
}

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
  // sendVideo(data: ArrayBuffer | TypedArray, width, height, format: 'I420'|'NV12'|'BGRA'|..., stride?: number)
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
    bool planar = (bd == 2);
    int stride = (info.Length() > 4 && info[4].IsNumber()) ? info[4].As<Napi::Number>().Int32Value()
                                                          : (planar ? w : w * 4);
    size_t need = planar ? static_cast<size_t>(stride) * h * 3 / 2 : static_cast<size_t>(stride) * h;
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
    o.Set("slate", slating_.load());
    o.Set("width", lastW_.load());
    o.Set("height", lastH_.load());
    o.Set("connections", send_ ? g_ndi->send_get_no_connections(send_, 0) : 0);
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
    f.frame_rate_N = 30000;
    f.frame_rate_D = 1001;
    f.picture_aspect_ratio = 0.0f;  // square pixels
    f.frame_format_type = NDIlib_frame_format_type_progressive;
    f.timecode = NDIlib_send_timecode_synthesize;
    f.p_data = const_cast<uint8_t*>(data);
    f.line_stride_in_bytes = stride;
    g_ndi->send_send_video_v2(send_, &f);  // synchronous: buffer may be reused after return
  }

  void Run() {
    using namespace std::chrono;
    Frame work;
    auto lastSlate = steady_clock::now() - hours(1);
    while (running_) {
      bool have = false;
      {
        std::unique_lock<std::mutex> lk(mu_);
        cv_.wait_for(lk, milliseconds(100), [this] { return hasPending_ || !running_; });
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
      } else if (now - lastFrameAt_ > milliseconds(idleMs_) && now - lastSlate > milliseconds(200)) {
        Emit(slate_.data(), slateW_, slateH_, slateW_ * 2, NDIlib_FourCC_video_type_UYVY);
        lastSlate = now;
        slating_ = true;
      }
    }
  }

  std::string name_;
  std::string groups_;
  NDIlib_send_instance_t send_ = nullptr;
  int idleMs_ = 1000;
  int slateW_ = 1280;
  int slateH_ = 720;
  std::vector<uint8_t> slate_;

  std::thread worker_;
  std::atomic<bool> running_{false};
  std::mutex mu_;
  std::condition_variable cv_;
  Frame pending_;
  bool hasPending_ = false;
  std::chrono::steady_clock::time_point lastFrameAt_;

  std::atomic<uint64_t> received_{0}, sent_{0}, dropped_{0};
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

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("findSources", Napi::Function::New(env, FindSources));
  exports.Set("receiveFrame", Napi::Function::New(env, ReceiveFrame));
  exports.Set("Sender", Sender::Init(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(gmeet_iso_ndi, InitModule)
