// Linked into the Linux better-sqlite3 build (see package-core-linux.mjs), with the linker told to send
// stat64, fstat64, lstat64 and pthread_once here.
//
// stat64 and friends only became real glibc functions in 2.33. Before that they were header macros over
// the __x* calls below, which glibc has kept for old programs, so calling them works everywhere.
//
// The rest stands in for things libstdc++ and libgcc reach for when linked statically, which only exist
// on newer glibc. Each one is an optimisation or a rarely used path with a plain equivalent.

#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

#define LOCAL __attribute__((visibility("hidden")))

struct stat64;
struct dl_find_object;

extern int __xstat64(int version, const char *path, struct stat64 *result);
extern int __fxstat64(int version, int descriptor, struct stat64 *result);
extern int __lxstat64(int version, const char *path, struct stat64 *result);

__asm__(".symver __xstat64,__xstat64@GLIBC_2.2.5");
__asm__(".symver __fxstat64,__fxstat64@GLIBC_2.2.5");
__asm__(".symver __lxstat64,__lxstat64@GLIBC_2.2.5");

// The layout version glibc uses for struct stat on 64-bit x86.
#define STAT_VERSION 1

int __wrap_stat64(const char *path, struct stat64 *result) {
  return __xstat64(STAT_VERSION, path, result);
}

int __wrap_fstat64(int descriptor, struct stat64 *result) {
  return __fxstat64(STAT_VERSION, descriptor, result);
}

int __wrap_lstat64(const char *path, struct stat64 *result) {
  return __lxstat64(STAT_VERSION, path, result);
}

extern int omni_oldest_once(int *control, void (*routine)(void));
__asm__(".symver omni_oldest_once,pthread_once@GLIBC_2.2.5");

int __wrap_pthread_once(int *control, void (*routine)(void)) {
  return omni_oldest_once(control, routine);
}

// Zero tells libstdc++ to always use atomics, which is the safe answer.
LOCAL char __libc_single_threaded = 0;

// Failing here sends the unwinder to its slower dl_iterate_phdr lookup, which works on every glibc.
LOCAL int _dl_find_object(void *address, struct dl_find_object *result) {
  (void)address;
  (void)result;
  return -1;
}

LOCAL uint32_t arc4random(void) {
  uint32_t value = 0;
  if (getentropy(&value, sizeof value) != 0) abort();
  return value;
}

// strtoul with C23's 0b prefix, which nothing here parses.
LOCAL unsigned long __isoc23_strtoul(const char *text, char **end, int base) {
  return strtoul(text, end, base);
}
