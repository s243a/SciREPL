"""
sharedfs — Python bridge to SciREPL SharedVFS.

Provides read/write/list operations on the shared virtual filesystem
so Python can exchange files with Bash and Prolog kernels.

Paths under /tmp/, /shared/, and /education/ are accessible to all kernels.
"""
import js
import json

_vfs = js.window.sharedVFS


def read_text(path):
    """Read a file as a UTF-8 string."""
    result = _vfs.readFile(path, 'utf8')
    if result is None:
        raise FileNotFoundError(f"No such file: {path}")
    return str(result)


def write_text(path, content):
    """Write a string to a file."""
    _vfs.writeFile(path, str(content), 'python')


def read_bytes(path):
    """Read a file as bytes."""
    result = _vfs.vfs_read_file(path)
    if result is None:
        raise FileNotFoundError(f"No such file: {path}")
    return bytes(result)


def write_bytes(path, content):
    """Write bytes to a file."""
    arr = js.Uint8Array.new(len(content))
    for i, b in enumerate(content):
        arr[i] = b
    _vfs.writeFile(path, arr, 'python')


def exists(path):
    """Check if a path exists in the SharedVFS."""
    return bool(_vfs.exists(path))


def listdir(path='/shared'):
    """List directory contents. Returns list of entry dicts with name, size, is_dir."""
    result = _vfs.vfs_list_dir(path)
    if result is None:
        raise FileNotFoundError(f"No such directory: {path}")
    return json.loads(str(result))


def mkdir(path):
    """Create a directory."""
    _vfs.mkdir(path)


def stat(path):
    """Get file info. Returns dict with size, is_dir, modified."""
    result = _vfs.vfs_stat(path)
    if result is None:
        raise FileNotFoundError(f"No such file: {path}")
    return json.loads(str(result))


def remove(path):
    """Remove a file or empty directory."""
    if not _vfs.vfs_remove(path):
        raise OSError(f"Could not remove: {path}")
