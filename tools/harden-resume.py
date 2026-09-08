#!/usr/bin/env python3
"""Close the ghost-shot window that QA found around pause and resume.

pause() already drops the held button and the latch, but exitPointerLock is
not instantaneous. Between the call and the browser actually releasing the
lock, document.pointerLockElement is still the canvas, so a mousedown in
that window passes the guard in the handler and latches a press nobody will
consume until the player resumes. The result is a shot the player never
asked for.

Both places that put the game back into 'play' now clear the latch, so a
resume always begins with no pending press.

Every replacement asserts its anchor appears exactly once. The script either
reproduces the reviewed result or fails loudly.
"""

import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(path):
    with io.open(os.path.join(ROOT, path), encoding="utf-8", newline="") as fh:
        return fh.read()


def write(path, text):
    with io.open(os.path.join(ROOT, path), "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            "anchor %r matched %d times, expected exactly 1" % (label, count)
        )
    return text.replace(old, new)


def main():
    main_js = read("src/main.js")

    main_js = replace_once(
        main_js,
        """      else if (locked && this.state === 'paused') {
        this.state = 'play';
""",
        """      else if (locked && this.state === 'paused') {
        this.state = 'play';
        // exitPointerLock is not instantaneous. A click landing between
        // pause() and the actual release still passes the handler guard and
        // latches a press, so resume starts from a clean latch.
        this.trigger.clear();
""",
        "resume via pointer lock",
    )

    main_js = replace_once(
        main_js,
        """    if (this.state === 'dead') this.resetRun();
    this.state = 'play';
""",
        """    if (this.state === 'dead') this.resetRun();
    this.state = 'play';
    this.trigger.clear();
""",
        "start",
    )

    write("src/main.js", main_js)

    tests = read("tests/logic.test.mjs")

    tests = replace_once(
        tests,
        """test('a dropped frame fires a semi-auto weapon exactly once', () => {""",
        """test('a press latched while pausing is not fired on resume', () => {
  const t = new Trigger();
  t.press();
  // pause() drops the held button and the latch.
  t.clear();
  // exitPointerLock has not landed yet, so this click still gets through.
  t.press();
  // Resume clears the latch a second time, which is the fix.
  t.clear();
  assert.equal(t.sample(), false, 'resume must not fire a shot nobody aimed');
  t.press();
  t.release();
  assert.equal(t.sample(), true, 'a fresh press after resume still fires');
  assert.equal(t.sample(), false, 'and it is still consumed exactly once');
});

test('a dropped frame fires a semi-auto weapon exactly once', () => {""",
        "logic test insertion point",
    )

    write("tests/logic.test.mjs", tests)

    print("patched src/main.js and tests/logic.test.mjs")


if __name__ == "__main__":
    main()
    sys.exit(0)
