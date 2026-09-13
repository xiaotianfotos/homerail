"""Private durable storage and Linux process identity for the skill watcher."""
import json
import os
from pathlib import Path
import tempfile


def process_identity(pid):
    try:
        if type(pid) is not int or pid <= 0:
            return None
        text = Path(f'/proc/{pid}/stat').read_text()
        fields = text[text.rfind(') ') + 2:].split()
        if fields[0] == 'Z': return None
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]
    except (OSError, IndexError):
        return None


def save_text(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    directory = os.open(path.parent, os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)


def save(path, value):
    save_text(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))
