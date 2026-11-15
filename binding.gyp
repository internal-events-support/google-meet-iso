{
  "targets": [
    {
      "target_name": "gmeet_iso_ndi",
      "sources": ["native/ndi_addon.cc"],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")",
        "<!(node scripts/ndi-sdk-dir.js include)"
      ],
      "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "NOMINMAX"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17", "/utf-8"] }
      },
      "xcode_settings": { "GCC_ENABLE_CPP_EXCEPTIONS": "YES", "CLANG_CXX_LANGUAGE_STANDARD": "c++17" }
    }
  ]
}
