'use strict';

// This validates the renderer's managed-agent event path with messages injected
// by the Electron main process. It deliberately never calls runAgentTask.
const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rooms-managed-ui-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve('.')],
      env: { ...process.env, AGENT_ROOMS_TEST_MODE: '1', AGENT_ROOMS_TEST_DATA: data },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.rooms?.onAgentEvent);
    await app.evaluate(({ dialog }, cwd) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
    }, process.cwd());

    await page.getByRole('button', { name: /Choose a folder/ }).click();
    await page.getByRole('heading', { name: 'This room is ready.' }).waitFor();
    const roomId = await page.evaluate(async () => {
      const state = await window.rooms.loadState();
      return state.rooms[0].id;
    });
    assert.equal(typeof roomId, 'string');

    await page.getByLabel('Agent session limit').selectOption('2');
    await page.getByText('Allow agents to create sessions').click();
    await page.waitForFunction(async () => {
      const state = await window.rooms.loadState();
      return state.rooms[0]?.allowSpawn === true && state.rooms[0]?.maxAgents === 2;
    });
    assert.equal(await page.getByLabel('Pre-approve room tools').isChecked(), false);
    await page.getByText('Pre-approve room tools').click();
    await page.waitForFunction(async () => {
      const state = await window.rooms.loadState();
      return state.rooms[0]?.preapproveRoomTools === true && state.rooms[0]?.allowSpawn === true;
    });
    // The pre-approve explanation must not overclaim coverage of every
    // provider: Cursor only honors its own config-file allow rules.
    await page.getByText(/Does not apply to Cursor sessions/, { exact: false }).waitFor();

    const child = {
      id: 'synthetic-child',
      roomId,
      provider: 'codex',
      name: 'Codex child',
      status: 'idle',
    };
    const send = async (event) => {
      await app.evaluate(({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows()[0].webContents.send('rooms:agent-event', value);
      }, event);
    };
    // Registers a synthetic session directly on the real AgentEngine (via the test-only
    // global set in desktop/main.cjs), so rooms:rename-agent-session has something real to
    // rename without launching an actual provider process.
    const registerRealSession = async (session) => {
      await app.evaluate((_electron, value) => {
        const engine = global.__ROOMS_TEST_AGENT_ENGINE__;
        engine.sessions.set(value.id, {
          id: value.id,
          roomId: value.roomId,
          provider: value.provider,
          name: value.name,
          status: value.status,
          cwd: process.cwd(),
          queue: [],
          active: null,
          providerSessionId: null,
          token: null,
        });
      }, session);
    };
    await registerRealSession(child);
    await send({ type: 'session-created', sessionId: child.id, roomId, session: child });
    await page.getByText('Codex child', { exact: true }).first().waitFor();
    await page.getByText('Codex child managed session created.', { exact: true }).waitFor();

    await send({
      type: 'task-started',
      sessionId: child.id,
      roomId,
      taskId: 'synthetic-task',
      text: 'Exact synthetic task text',
    });
    await page.getByRole('button', { name: 'Focus Codex child session' }).getByText('running').waitFor();
    await page.getByText('Codex child started a task.', { exact: true }).waitFor();
    await page.getByText('Exact synthetic task text', { exact: true }).waitFor();

    // A second managed session is the delegation target, so the delegation
    // view can resolve a real name instead of a raw session id.
    const reviewer = {
      id: 'synthetic-reviewer',
      roomId,
      provider: 'claude',
      name: 'Claude reviewer',
      status: 'idle',
    };
    await registerRealSession(reviewer);
    await send({ type: 'session-created', sessionId: reviewer.id, roomId, session: reviewer });
    await page.getByText('Claude reviewer', { exact: true }).first().waitFor();

    await send({
      type: 'delegation',
      sessionId: child.id,
      roomId,
      taskId: 'synthetic-task',
      targetSessionId: reviewer.id,
      targetTaskId: 'synthetic-review-task',
      text: 'Codex child → Claude reviewer',
    });
    await page.getByText('Delegation: Codex child → Claude reviewer', { exact: true }).waitFor();
    // The source transcript labels this a DELEGATION entry, not a generic STATUS one.
    await page
      .locator('#pane-synthetic-child .transcript-entry.delegation span')
      .getByText('DELEGATION', { exact: true })
      .waitFor();

    // Room Activity delegation view: entries resolve by session id and show
    // the provider, so two sessions can never look ambiguous even if they
    // ever shared a display name. The child task starts out with no proven
    // state ("delegated"), grouped/indented under its parent task.
    const delegationChild = page.locator('.delegation-child', {
      hasText: 'Codex child (Codex) → Claude reviewer (Claude Code)',
    });
    await delegationChild.waitFor();
    assert.equal(
      (await delegationChild.locator('.delegation-state').innerText()).trim(),
      'delegated',
      'Delegated child task must not claim a status no event proved yet',
    );
    const delegationParent = page.locator('.delegation-parent', { hasText: 'Codex child (Codex)' });
    assert.equal((await delegationParent.locator('.delegation-state').innerText()).trim(), 'started');

    await send({
      type: 'task-started',
      sessionId: reviewer.id,
      roomId,
      taskId: 'synthetic-review-task',
      text: 'Review the change',
    });
    await page.waitForFunction(() => {
      const el = document.querySelector('.delegation-child');
      return el?.querySelector('.delegation-state')?.textContent === 'started';
    });

    await send({
      type: 'output',
      sessionId: child.id,
      roomId,
      taskId: 'synthetic-task',
      text: 'Synthetic bridge output',
    });
    await page.getByText('Synthetic bridge output', { exact: true }).waitFor();
    await page.getByText('Codex child: Synthetic bridge output', { exact: true }).waitFor();

    await send({ type: 'task-completed', sessionId: child.id, roomId, taskId: 'synthetic-task' });
    await page.getByRole('button', { name: 'Focus Codex child session' }).getByText('idle').waitFor();
    await page.getByText('Codex child completed a task.', { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('.delegation-parent');
      return el?.querySelector('.delegation-state')?.textContent === 'completed';
    });

    await send({
      type: 'task-completed',
      sessionId: reviewer.id,
      roomId,
      taskId: 'synthetic-review-task',
    });
    await page.waitForFunction(() => {
      const el = document.querySelector('.delegation-child');
      return el?.querySelector('.delegation-state')?.textContent === 'completed';
    });

    // Live-demo regressions: the delegation row shows the full target name and
    // provider (wraps, never ellipsized), and Room Activity keeps the newest
    // entry in view rather than staying scrolled to the top.
    const delegationFits = await page.evaluate(() => {
      const el = document.querySelector('.delegation-child .delegation-name');
      return el ? el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis' : false;
    });
    assert.ok(delegationFits, 'Delegation child name must not be truncated');
    await page.waitForFunction(() => {
      const list = document.querySelector('.activity-list');
      return !!list && list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    });

    // Clicking a delegation entry focuses that session in the sidebar.
    await delegationChild.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Focus Claude reviewer session"]')
          ?.classList.contains('focused') === true,
    );

    // permission-denied: rendered as a visible warning, both in Room
    // Activity and in the source session's transcript, clearly attributed
    // to the provider, and never implying provider permissions were
    // bypassed.
    await send({
      type: 'permission-denied',
      sessionId: child.id,
      roomId,
      taskId: 'synthetic-task',
      text: 'Bash command blocked by policy',
    });
    await page
      .locator('.activity-item.warning', {
        hasText:
          'Permission denied for Codex child (Codex): Bash command blocked by policy. Provider permissions were not bypassed.',
      })
      .waitFor();
    await page
      .locator('#pane-synthetic-child .transcript-entry.warning', {
        hasText:
          'Permission denied by Codex: Bash command blocked by policy. Provider permissions were not bypassed.',
      })
      .waitFor();
    await page
      .locator('#pane-synthetic-child .transcript-entry.warning span')
      .getByText('WARNING · CODEX', { exact: true })
      .waitFor();
    // Output that resumes after a warning starts a new agent entry; the
    // runner's segment-break newlines must not render as a blank gap there.
    await send({
      type: 'output',
      sessionId: child.id,
      roomId,
      taskId: 'synthetic-task',
      text: '\n\nResumed after denial',
    });
    const resumed = page.locator('#pane-synthetic-child .transcript-entry.agent p').last();
    await resumed.getByText('Resumed after denial').waitFor();
    assert.equal(await resumed.evaluate((el) => el.textContent), 'Resumed after denial');

    // A Cursor managed session, so a Cursor-specific permission denial also
    // renders with a real "Cursor" label/icon (never a hardcoded two-provider
    // assumption) and is attributed correctly.
    const cursorAgent = {
      id: 'synthetic-cursor',
      roomId,
      provider: 'cursor',
      name: 'Cursor helper',
      status: 'idle',
    };
    await send({ type: 'session-created', sessionId: cursorAgent.id, roomId, session: cursorAgent });
    await page.locator('#pane-synthetic-cursor .provider-mark.cursor', { hasText: '▣' }).waitFor();
    await send({
      type: 'permission-denied',
      sessionId: cursorAgent.id,
      roomId,
      text: 'room_send: User rejected MCP: room_send',
    });
    await page
      .locator('#pane-synthetic-cursor .transcript-entry.warning', {
        hasText:
          'Permission denied by Cursor: room_send: User rejected MCP: room_send. Provider permissions were not bypassed.',
      })
      .waitFor();

    // Rename: managed session, inline from the pane header, Enter to save.
    await page.locator('#pane-synthetic-child .pane-name').dblclick();
    const managedRenameInput = page.locator('#pane-synthetic-child').getByLabel('Rename Codex child');
    await managedRenameInput.waitFor();
    await managedRenameInput.fill('Codex lead');
    await managedRenameInput.press('Enter');
    await page.locator('#pane-synthetic-child .pane-name', { hasText: 'Codex lead' }).waitFor();
    await page.getByRole('button', { name: 'Focus Codex lead session' }).waitFor();
    await page.getByText('Codex child renamed to Codex lead.', { exact: true }).waitFor();

    // Rename uniqueness: renaming another session to a name already in use
    // in this room must be BLOCKED with an inline error, editing left open,
    // and no name actually applied to the wrong (or any) session.
    await page.locator('#pane-synthetic-reviewer .pane-name').dblclick();
    const reviewerRenameInput = page
      .locator('#pane-synthetic-reviewer')
      .getByLabel('Rename Claude reviewer');
    await reviewerRenameInput.fill('Codex lead');
    await reviewerRenameInput.press('Enter');
    await page
      .locator('#pane-synthetic-reviewer .rename-error', {
        hasText: 'Already used in this room. room_send addresses sessions by name.',
      })
      .waitFor();
    // Rejected: still editing, and neither session actually got renamed.
    assert.equal(await reviewerRenameInput.isVisible(), true, 'Rejected rename must keep editing open');
    assert.equal(
      await page.locator('#pane-synthetic-child .pane-name', { hasText: 'Codex lead' }).isVisible(),
      true,
      'The other pane (Codex lead) must be unaffected by the rejected rename',
    );
    // A rejected rename leaves editing open (nothing was applied); Escape
    // discards it and the original name is unchanged.
    await reviewerRenameInput.press('Escape');
    await page.locator('#pane-synthetic-reviewer .pane-name', { hasText: 'Claude reviewer' }).waitFor();

    // Escape cancels a rename in progress without applying it, from the sidebar.
    await page.getByRole('button', { name: 'Focus Claude reviewer session' }).dblclick();
    const sidebarRenameInput = page.locator('.room-list').getByLabel('Rename Claude reviewer');
    await sidebarRenameInput.fill('Should not stick');
    await sidebarRenameInput.press('Escape');
    await page.getByRole('button', { name: 'Focus Claude reviewer session' }).waitFor();

    // Rename: native terminal session, inline from the pane header.
    await page.getByRole('button', { name: /Add session/ }).click();
    await page
      .locator('.picker-menu')
      .getByRole('button', { name: /Terminal/, exact: false })
      .first()
      .click();
    const terminalCard = page.locator('.terminal-card:not(.managed-card)');
    await terminalCard.waitFor();
    await terminalCard.locator('.pane-name').dblclick();
    const terminalRenameInput = terminalCard.locator('.pane-name-input');
    await terminalRenameInput.fill('Scratch shell');
    await terminalRenameInput.press('Enter');
    await terminalCard.locator('.pane-name', { hasText: 'Scratch shell' }).waitFor();
    await page.getByRole('button', { name: 'Focus Scratch shell session' }).waitFor();

    // Keyboard nav: arrow keys move roving focus across the session list.
    const firstRow = page.locator('.session-row').first();
    await firstRow.focus();
    const firstLabel = await firstRow.getAttribute('aria-label');
    await page.keyboard.press('ArrowDown');
    const activeLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    assert.notEqual(activeLabel, firstLabel, 'ArrowDown must move focus to the next session row');

    // Room Activity panel must stay fully on-screen (no clipped/cut-off
    // text) even at the app's supported minimum window width.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(860, 700);
    });
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.activity-panel');
      const rect = panel?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        panelRight: rect?.right,
        feedHeight: document.querySelector('.activity-list')?.clientHeight ?? 0,
      };
    });
    assert.ok(layout.panelRight <= layout.innerWidth, 'Room Activity panel must not extend past the window');
    // The feed must stay readable even when delegations, policy and handoff
    // share the panel in a short window (the live demo saw it crushed to ~1 item).
    assert.ok(layout.feedHeight >= 200, `Room Activity feed must not collapse (got ${layout.feedHeight}px)`);
    assert.ok(
      layout.scrollWidth <= layout.innerWidth,
      'The app must not need horizontal scroll/clip at the 860px minimum width',
    );
    await page.screenshot({ path: 'doc/screenshots/activity-panel-860.png' });

    console.log(
      'PASS: synthetic managed-agent child session, lifecycle, transcript, activity, room policy UI, nested delegation view (by id, with provider), permission-denied warnings (incl. Cursor), rename (incl. blocked duplicate), and layout at the minimum window width.',
    );
  } finally {
    if (app) await app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
