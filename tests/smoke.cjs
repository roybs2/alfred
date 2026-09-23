'use strict';
const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-smoke-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve('.')],
      env: { ...process.env, AGENT_ROOMS_TEST_MODE: '1', AGENT_ROOMS_TEST_DATA: data },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.rooms);
    const agents = await page.evaluate(() => window.rooms.detectAgents());
    assert(
      agents.some((a) => a.id === 'shell' && a.available),
      'Real shell must be detected',
    );
    const result = await page.evaluate(async (cwd) => {
      const api = window.rooms;
      const id = 'smoke-shell';
      let output = '';
      const dispose = api.onOutput((event) => {
        if (event.id === id) output += event.data;
      });
      await api.createSession({ id, provider: 'shell', cwd, cols: 90, rows: 24 });
      await api.resizeSession({ id, cols: 100, rows: 30 });
      await api.writeSession({ id, data: "printf 'ROOMS_%s_OK\\n' SMOKE\r" });
      await new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (output.includes('ROOMS_SMOKE_OK')) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - start > 8000) {
            clearInterval(timer);
            reject(new Error('Shell output timeout'));
          }
        }, 40);
      });
      await api.closeSession(id);
      dispose();
      return output;
    }, process.cwd());
    assert(result.includes('ROOMS_SMOKE_OK'));
    await page.evaluate(async () => {
      let rejected = false;
      try {
        await window.rooms.createSession({
          id: 'bad',
          provider: 'arbitrary-command',
          cwd: '/tmp',
          cols: 80,
          rows: 24,
        });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error('Provider allowlist not enforced');
    });
    await app.evaluate(({ dialog }, cwd) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
    }, process.cwd());
    await page.evaluate(() => {
      window.__smokeOutput = '';
      window.rooms.onOutput((e) => {
        window.__smokeOutput += e.data;
      });
    });
    await page.getByRole('button', { name: /Choose a folder/ }).click();
    await page.getByRole('button', { name: /Add session/ }).click();
    await page
      .locator('.picker-menu')
      .getByRole('button', { name: /Terminal/ })
      .click();
    await page.locator('.terminal-card').waitFor();
    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.type("printf 'VISIBLE_%s_OK\\n' SHELL");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('.terminal-card')?.textContent?.includes('running'),
    );
    await page.waitForFunction(() => window.__smokeOutput.includes('VISIBLE_SHELL_OK'));
    await page.getByLabel('Manual handoff text').fill("printf 'HANDOFF_%s_OK\\n' SAFE\n");
    await page.getByRole('button', { name: 'Paste one line to terminal' }).click();
    await page.waitForTimeout(200);
    assert(
      !(await page.evaluate(() => window.__smokeOutput.includes('HANDOFF_SAFE_OK'))),
      'Paste must not auto-submit',
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__smokeOutput.includes('HANDOFF_SAFE_OK'));
    await page.getByRole('button', { name: /Add session/ }).click();
    await page
      .locator('.picker-menu')
      .getByRole('button', { name: /Terminal/ })
      .click();
    await page.waitForFunction(() => document.querySelectorAll('.terminal-card').length === 2);
    await page.locator('.xterm-helper-textarea').last().focus();
    await page.keyboard.type("printf 'SECOND_%s_OK\\n' SESSION");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__smokeOutput.includes('SECOND_SESSION_OK'));

    // Recovery/history: explicitly closing a terminal session records it as "ended" (never
    // "running"/"idle") in a Session history list, with a Reopen action — metadata only, no
    // transcript restore.
    await page.locator('.terminal-card').first().locator('.close-pane').click();
    await page.waitForFunction(() => document.querySelectorAll('.terminal-card').length === 1);
    const closedHistoryRow = page.locator('.session-history-row', { hasText: 'ended · stopped' });
    await closedHistoryRow.waitFor();
    await closedHistoryRow.getByRole('button', { name: /Reopen/ }).waitFor();

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/tmp'] });
    });
    await page.getByRole('button', { name: 'Create room and choose a folder' }).click();
    await page.getByRole('heading', { name: 'This room is ready.' }).waitFor();
    assert.equal(await page.locator('.terminal-card:visible').count(), 0);

    // Open a terminal in this second room ("tmp") and leave it running (never explicitly
    // closed) — quitting with it still open must still show it as "ended" after restart,
    // since no PTY survives a restart either way (see doc/decisions.md).
    await page.getByRole('button', { name: /Add session/ }).click();
    await page
      .locator('.picker-menu')
      .getByRole('button', { name: /Terminal/ })
      .click();
    // Scoped to the current room's visible pane: the previous room's terminal stays mounted
    // (but hidden) in the background, so an unscoped `.terminal-card` would match both.
    await page.locator('.terminal-card:visible').waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector('.pane-anchor:not(.pane-hidden) .terminal-card')
        ?.textContent?.includes('running'),
    );

    await page.getByRole('button', { name: 'Open room agent-rooms', exact: true }).click();
    assert.equal(
      await page.locator('.terminal-card:visible').count(),
      1,
      'The remaining terminal survives room switch',
    );
    const state = await page.evaluate(() => window.rooms.loadState());
    assert(Array.isArray(state.rooms) && state.rooms.length === 2, 'Room metadata must persist');
    fs.mkdirSync('doc/screenshots', { recursive: true });
    await page.screenshot({ path: 'doc/screenshots/workspace.png' });
    await page.getByRole('button', { name: 'Room options' }).click();
    await page.getByRole('button', { name: 'Remove room', exact: true }).click();
    await page.getByRole('button', { name: /Confirm remove/ }).click();
    // Only the "tmp" room's terminal remains (left running on purpose, see above) — "agent-rooms"
    // and its own terminal are gone.
    await page.waitForFunction(() => document.querySelectorAll('.terminal-card').length === 1);
    await app.close();
    app = await electron.launch({
      args: [path.resolve('.')],
      env: { ...process.env, AGENT_ROOMS_TEST_MODE: '1', AGENT_ROOMS_TEST_DATA: data },
    });
    const restored = await app.firstWindow();
    await restored.getByRole('button', { name: 'Open room tmp', exact: true }).waitFor();
    assert.equal(
      await restored.locator('.terminal-card').count(),
      0,
      'Restart restores metadata, not fictitious live sessions',
    );

    // The "tmp" room's terminal, left running when the app quit, now shows as ended (never
    // running/idle) with a Reopen action; clicking it opens a real new terminal (no transcript
    // is restored — none was ever stored).
    await restored.getByRole('button', { name: 'Open room tmp', exact: true }).click();
    const restoredHistoryRow = restored.locator('.session-history-row', { hasText: 'ended · stopped' });
    await restoredHistoryRow.waitFor();
    await restoredHistoryRow.getByRole('button', { name: /Reopen/ }).click();
    await restored.locator('.terminal-card').waitFor();
    await restored.waitForFunction(() =>
      document.querySelector('.terminal-card')?.textContent?.includes('running'),
    );

    // Clear history removes the recovery list for this room.
    await restored.getByRole('button', { name: /Clear history/ }).click();
    await restored.locator('.session-history').waitFor({ state: 'detached' });

    console.log(
      'PASS: desktop boot, real PTY I/O, resize, close, provider validation, two UI terminals, ' +
        'manual paste without submission, room switching, removal, restart persistence, and ' +
        'session history (ended sessions, reopen, clear history).',
    );
  } finally {
    if (app) await app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
