// Force-included into the Linux better-sqlite3 build (see package-core-linux.mjs).
//
// A native module asks for the newest version of each glibc function on the machine that compiled it,
// so a build from a new distro refuses to load on an older one. These lines ask for the original
// versions instead, which every glibc still ships, so one build runs on anything since glibc 2.28.

#define OMNI_OLDEST(name) __asm__(".symver " #name "," #name "@GLIBC_2.2.5")

OMNI_OLDEST(exp);
OMNI_OLDEST(fmod);
OMNI_OLDEST(log);
OMNI_OLDEST(log2);
OMNI_OLDEST(pow);

OMNI_OLDEST(dlclose);
OMNI_OLDEST(dlerror);
OMNI_OLDEST(dlopen);
OMNI_OLDEST(dlsym);

OMNI_OLDEST(pthread_create);
OMNI_OLDEST(pthread_join);
OMNI_OLDEST(pthread_mutex_trylock);
OMNI_OLDEST(pthread_mutexattr_destroy);
OMNI_OLDEST(pthread_mutexattr_init);
OMNI_OLDEST(pthread_mutexattr_settype);
OMNI_OLDEST(pthread_once);
