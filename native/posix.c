/* Fixed-arity wrapper: Darwin arm64 passes openat's variadic mode on the stack. */
extern int openat(int directory, const char *path, int flags, ...);
int lazyhb_openat(int directory, const char *path, int flags, int mode) {
    return openat(directory, path, flags, mode);
}
