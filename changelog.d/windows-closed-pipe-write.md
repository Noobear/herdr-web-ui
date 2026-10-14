### Fixed
- On Windows, a write to a helper process that had already exited no longer takes the server down:
  closing a terminal whose helper was gone, or an upload to a remote PC whose SSH connection
  dropped, ended the whole process. The write now fails like any other.
