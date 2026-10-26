# Temporary Expat security backport

This is the same signed Alpine package approach used by JustCD. Alpine 3.24's
Expat package is replaced with the checksum-verified 2.9.0 source release until
the stable repository includes the fixes listed in `APKBUILD`.

Both backend and combined Dockerfiles build the package with `abuild`, install
it using the generated public key, and retain APK package/version metadata.
The private signing key stays in the build stage. No edge repository is used.
Remove the backport stage once stable Alpine provides Expat >= 2.9.0.
