#include <napi/native_api.h>
#include <dlfcn.h>
// 故意缺失：detached 线程、SIGSYS shim、UV_USE_IO_URING、argc 哨兵处理
static napi_value StartNode(napi_env env, napi_callback_info info) {
  void* h = dlopen("libnode.so", RTLD_NOW);
  return nullptr;
}
