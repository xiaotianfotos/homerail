#include <sys/prctl.h>
#include <unistd.h>

/*
 * execve(2) resets a normal executable's dumpable flag. Loading this library
 * into Codex applies the restriction after that reset, before program startup.
 * The flag prevents same-uid tool subprocesses from reading Codex's provider
 * credential through /proc/<pid>/environ or ptrace.
 */
__attribute__((constructor)) static void homerail_disable_dumpability(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    static const char message[] = "homerail: failed to disable Codex process dumpability\n";
    (void)write(STDERR_FILENO, message, sizeof(message) - 1);
    _exit(70);
  }
}
