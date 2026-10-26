"""Assemble a shell-less CPython rootfs, retaining provenance for shipped OS libs."""
import pathlib
import re
import shutil
import subprocess

root = pathlib.Path('/runtime')
root.mkdir()
packages = {'base-files', 'ca-certificates', 'tzdata'}


def copy(source):
    path = pathlib.Path(source)
    destination = root / path.relative_to('/')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if path.is_dir():
        shutil.copytree(path, destination, symlinks=True, dirs_exist_ok=True)
    else:
        shutil.copy2(path, destination)


# Desktop GUI, interactive terminal and OS UUID helpers are unused by this HTTP service.
# uuid.uuid4() continues to use os.urandom without the optional _uuid module.
for pattern in ('_tkinter*.so', '_curses*.so', 'readline*.so', '_uuid*.so'):
    for path in pathlib.Path('/usr/local/lib/python3.14/lib-dynload').glob(pattern):
        path.unlink()
copy('/usr/local')

# ldd resolves transitive dependencies, including each extension's dlopen libs.
# Explicitly include the C++ and OpenMP runtimes used by numerical wheels.
elfs = [pathlib.Path('/usr/local/bin/python3.14')]
elfs += list(pathlib.Path('/usr/local/lib').rglob('*.so'))
elfs += list(pathlib.Path('/usr/lib').glob('*/libgomp.so.1'))
elfs += list(pathlib.Path('/usr/lib').glob('*/libstdc++.so.6'))
# manylinux wheels also link glibc's pre-2.34 compatibility sonames.
for soname in ('libpthread.so.0', 'libdl.so.2', 'librt.so.1', 'libutil.so.1', 'libresolv.so.2'):
    elfs += list(pathlib.Path('/usr/lib').glob('*/' + soname))
libraries = set()
for elf in elfs:
    output = subprocess.run(['ldd', str(elf)], text=True, capture_output=True, check=True).stdout
    if 'not found' in output:
        raise RuntimeError(output)
    libraries.update(re.findall(r'(?:=>\s+|^\s*)(/\S+)', output, re.MULTILINE))
    if not str(elf).startswith('/usr/local/'):
        libraries.add(str(elf))
for library in sorted(libraries):
    copy(library)
    if not library.startswith('/usr/local/'):
        # Debian uses merged /usr; ownership is recorded under the resolved path.
        owners = subprocess.check_output(['dpkg-query', '-S', str(pathlib.Path(library).resolve())], text=True)
        packages.update(line.split(': ')[0].split(':')[0] for line in owners.splitlines())

for path in ('/etc/ssl', '/usr/lib/ssl', '/usr/share/zoneinfo', '/etc/passwd',
             '/etc/group', '/etc/debian_version', '/etc/nsswitch.conf', '/etc/ld.so.cache', '/etc/os-release'):
    copy(path)
status = pathlib.Path('/var/lib/dpkg/status').read_text()
records = [record for record in status.split('\n\n')
           if re.search(r'^Package: (.+)$', record, re.MULTILINE)
           and re.search(r'^Package: (.+)$', record, re.MULTILINE).group(1) in packages]
metadata = root / 'var/lib/dpkg'
metadata.mkdir(parents=True)
(metadata / 'status').write_text('\n\n'.join(records) + '\n\n')
# Preserve Debian source/copyright attribution for the selected packages.
for package in packages:
    path = pathlib.Path('/usr/share/doc') / package
    if path.exists():
        copy(path)
(root / 'tmp').mkdir(mode=0o1777)
(root / 'tmp').chmod(0o1777)
print('Runtime OS packages:', ', '.join(sorted(packages)))
