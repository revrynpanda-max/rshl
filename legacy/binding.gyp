{
  "targets": [{
    "target_name": "rshl_native",
    "sources": [ "native/rshl_native.cpp" ],
    "include_dirs": [ "<!@(node -p \"require('node-addon-api').include\")" ],
    "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
    "conditions": [
      ["OS=='win'", {
        "msvs_settings": {
          "VCCLCompilerTool": {
            "AdditionalOptions": [ "/arch:AVX2", "/O2", "/fp:fast", "/openmp" ]
          }
        }
      }],
      ["OS=='linux'", {
        "cflags_cc": [ "-mavx2", "-O3", "-ffast-math", "-fopenmp" ],
        "libraries": [ "-lgomp" ]
      }],
      ["OS=='mac'", {
        "cflags_cc": [ "-O3", "-ffast-math" ]
      }]
    ]
  }]
}
