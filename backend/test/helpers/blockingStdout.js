/**
 * `node --test --test-force-exit` runs each file in a child process that
 * reports results as binary frames over a stdout pipe. On macOS that pipe is
 * written asynchronously, so a file that reports more than roughly 64 KB of
 * frames can still have unflushed data when force-exit ends the child. The
 * truncated final frame makes the parent runner either spin forever while it
 * drains the buffer or silently drop the file's individual test results.
 *
 * Importing this module makes stdout writes synchronous so every frame is
 * delivered before the child exits. It only changes how results are delivered,
 * not what the tests assert. Import it from any test file whose reporter output
 * is large (many tests or subtests).
 */
const handle = process.stdout?._handle;
if (typeof handle?.setBlocking === 'function') handle.setBlocking(true);
