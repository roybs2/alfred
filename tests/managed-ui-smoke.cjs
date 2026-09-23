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
    // Asserts that every pair of visible session panes has non-intersecting
    // bounding rects, and that each pane's status pill and close button stay
    // fully inside its own pane — the concrete guarantee that a narrow/
    // dragged/degraded column layout never overlaps or hides pane controls.
    const assertPanesDontOverlap = async (message) => {
      const report = await page.evaluate(() => {
        const panes = Array.from(document.querySelectorAll('.pane-anchor:not(.pane-hidden)')).filter(
          (el) => el.getBoundingClientRect().width > 0,
        );
        const rectOf = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        };
        const within = (outer, inner) =>
          !inner ||
          (inner.x >= outer.x - 0.5 &&
            inner.right <= outer.right + 0.5 &&
            inner.y >= outer.y - 0.5 &&
            inner.bottom <= outer.bottom + 0.5);
        const intersects = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
        const entries = panes.map((el) => ({
          id: el.id,
          rect: rectOf(el),
          status: el.querySelector('.run-state') ? rectOf(el.querySelector('.run-state')) : null,
          close: el.querySelector('.close-pane') ? rectOf(el.querySelector('.close-pane')) : null,
        }));
        const overlaps = [];
        for (let i = 0; i < entries.length; i++)
          for (let j = i + 1; j < entries.length; j++)
            if (intersects(entries[i].rect, entries[j].rect)) overlaps.push([entries[i].id, entries[j].id]);
        const outOfBounds = entries
          .filter((e) => !within(e.rect, e.status) || !within(e.rect, e.close))
          .map((e) => e.id);
        return { overlaps, outOfBounds };
      });
      assert.equal(
        report.overlaps.length,
        0,
        message + ': panes must never overlap, got ' + JSON.stringify(report.overlaps),
      );
      assert.equal(
        report.outOfBounds.length,
        0,
        message +
          ": each pane's status and close button must stay inside its own pane, violated by " +
          JSON.stringify(report.outOfBounds),
      );
    };
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
          providerSessionId: value.providerSessionId || null,
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

    // Markdown in agent output: bold/italic/inline code/code block/list/heading/
    // link render as real elements, but a <script>/<img onerror> in the same
    // text must stay inert plain text — never dangerouslySetInnerHTML.
    const mdText =
      '## Heading\n\n' +
      'Some **bold** and *italic* and `inline code` text.\n\n' +
      '- item one\n- item two\n\n' +
      '```\ncode block line\n```\n\n' +
      '[a link](https://example.com/x) plus <script>window.__xssFired = true</script> ' +
      'and <img src=x onerror="window.__xssFired = true">';
    await send({
      type: 'output',
      sessionId: child.id,
      roomId,
      taskId: 'markdown-task',
      text: mdText,
    });
    const mdEntry = page.locator('#pane-synthetic-child .transcript-entry.agent').last();
    await mdEntry.locator('.md h2', { hasText: 'Heading' }).waitFor();
    await mdEntry.locator('.md strong', { hasText: 'bold' }).waitFor();
    await mdEntry.locator('.md em', { hasText: 'italic' }).waitFor();
    await mdEntry.locator('.md-code', { hasText: 'inline code' }).waitFor();
    await mdEntry.locator('.md-pre code', { hasText: 'code block line' }).waitFor();
    assert.equal(await mdEntry.locator('.md-list li').count(), 2, 'List items render as list items');
    const mdLink = mdEntry.locator('.md-link', { hasText: 'a link' });
    await mdLink.waitFor();
    assert.equal(
      await mdLink.getAttribute('title'),
      'https://example.com/x',
      'The URL is only ever shown as text (tooltip), never navigated',
    );
    assert.equal(
      await mdEntry.locator('a').count(),
      0,
      'Markdown links must never render as a navigable <a>',
    );
    assert.equal(
      await mdEntry.locator('script').count(),
      0,
      'A <script> in agent text must never become a real <script> element',
    );
    assert.equal(
      await mdEntry.locator('img').count(),
      0,
      'An <img onerror=...> in agent text must never become a real <img> element',
    );
    assert.equal(
      await page.evaluate(() => window.__xssFired),
      undefined,
      'A <script>/<img onerror> in agent text must never execute',
    );
    const mdRawText = await mdEntry.evaluate((el) => el.textContent || '');
    assert.ok(
      mdRawText.includes('<script>') && mdRawText.includes('<img'),
      'The raw tag text must still be visible as inert plain text',
    );

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

    // Usage: only ever shown when the provider actually reported it on
    // task-completed (never estimated), subtly under the completed task, with
    // a per-session running total in the pane header tooltip, labeled by
    // provider. Codex here reports tokens only (no cost), matching the real
    // backend behavior for that provider.
    await send({
      type: 'task-completed',
      sessionId: child.id,
      roomId,
      taskId: 'usage-task-1',
      usage: { inputTokens: 1200, outputTokens: 300 },
    });
    await page
      .locator('#pane-synthetic-child .transcript-entry.usage p', {
        hasText: '1.2k in / 300 out · reported by Codex',
      })
      .waitFor();
    const childBadge = page.locator('#pane-synthetic-child .usage-total-badge');
    await childBadge.waitFor();
    assert.equal(
      await childBadge.getAttribute('title'),
      'Session total (reported by Codex): 1.2k in / 300 out',
    );
    // A second completed task with usage accumulates into the running total.
    await send({
      type: 'task-completed',
      sessionId: child.id,
      roomId,
      taskId: 'usage-task-2',
      usage: { inputTokens: 800, outputTokens: 200 },
    });
    await page.waitForFunction(() => {
      const title = document
        .querySelector('#pane-synthetic-child .usage-total-badge')
        ?.getAttribute('title');
      return title === 'Session total (reported by Codex): 2k in / 500 out';
    });

    // A provider that reports cost too (Claude), formatted as in the spec example.
    await send({
      type: 'task-completed',
      sessionId: reviewer.id,
      roomId,
      taskId: 'usage-task-claude-1',
      usage: { costUsd: 0.14, inputTokens: 1200, outputTokens: 300 },
    });
    await page
      .locator('#pane-synthetic-reviewer .transcript-entry.usage p', {
        hasText: '$0.14 · 1.2k in / 300 out · reported by Claude Code',
      })
      .waitFor();
    const reviewerBadge = page.locator('#pane-synthetic-reviewer .usage-total-badge');
    await reviewerBadge.waitFor();
    assert.equal(
      await reviewerBadge.getAttribute('title'),
      'Session total (reported by Claude Code): $0.14 · 1.2k in / 300 out',
    );

    // No usage field on the event: nothing is shown, never estimated.
    await send({ type: 'task-completed', sessionId: cursorAgent.id, roomId, taskId: 'no-usage-task' });
    assert.equal(
      await page.locator('#pane-synthetic-cursor .usage-total-badge').count(),
      0,
      'No usage total badge when the provider never reported usage',
    );
    assert.equal(
      await page.locator('#pane-synthetic-cursor .transcript-entry.usage').count(),
      0,
      'No usage transcript line when the provider never reported usage',
    );

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

    // Resizable split panes + column layout control. Session order at this
    // point is: Codex lead (child), Claude reviewer, Cursor helper, Scratch
    // shell (terminal) — round-robin into columns means col0 gets rows 1,2
    // (child, cursor) and col1 gets rows 1,2 (reviewer, terminal).
    await page.getByRole('button', { name: 'Columns: 2' }).click();
    await page.waitForFunction(() => {
      const stack = document.querySelector('.terminal-stack');
      // Two data columns plus one fixed-width handle track between them.
      return (
        !!stack && getComputedStyle(stack).gridTemplateColumns.trim().split(/\s+/).length === 3
      );
    });
    const box = (id) => page.locator('#pane-' + id).boundingBox();
    let childBox = await box('synthetic-child');
    let reviewerBox = await box('synthetic-reviewer');
    let cursorBox = await box('synthetic-cursor');
    assert.ok(
      childBox.x < reviewerBox.x,
      'First two sessions land in different columns at Columns: 2',
    );
    assert.ok(
      Math.abs(childBox.x - cursorBox.x) < 2,
      'The third session wraps back into the first column',
    );
    assert.ok(
      cursorBox.y > childBox.y,
      'The third session stacks below the first session in its column',
    );

    // Dragging the handle right widens the left column and narrows the right one.
    const handle = page.locator('.column-handle').first();
    await handle.waitFor();
    const handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 120, handleBox.y + handleBox.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const widenedChildBox = await box('synthetic-child');
    const shrunkReviewerBox = await box('synthetic-reviewer');
    assert.ok(
      widenedChildBox.width > childBox.width,
      'Dragging the handle right widens the left column',
    );
    assert.ok(
      shrunkReviewerBox.width < reviewerBox.width,
      'Dragging the handle right narrows the right column',
    );
    await assertPanesDontOverlap('After a normal drag at Columns: 2');

    // An aggressive drag to the extreme (far past any reasonable column width)
    // must clamp at a safe minimum instead of ever overlapping the next pane
    // or hiding its status/close controls.
    const extremeHandleBox = await handle.boundingBox();
    await page.mouse.move(
      extremeHandleBox.x + extremeHandleBox.width / 2,
      extremeHandleBox.y + extremeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(extremeHandleBox.x + 4000, extremeHandleBox.y + extremeHandleBox.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.waitForTimeout(100);
    await assertPanesDontOverlap('After dragging a handle to the extreme');
    const extremeReviewerBox = await box('synthetic-reviewer');
    assert.ok(
      extremeReviewerBox.width >= 200,
      `The narrowed column must clamp at a content-safe minimum, got ${extremeReviewerBox.width}px`,
    );
    // Same check in the opposite direction, so both sides of the clamp are covered.
    await page.mouse.move(
      (await handle.boundingBox()).x + extremeHandleBox.width / 2,
      extremeHandleBox.y + extremeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(extremeHandleBox.x - 4000, extremeHandleBox.y + extremeHandleBox.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.waitForTimeout(100);
    await assertPanesDontOverlap('After dragging a handle to the opposite extreme');
    const extremeChildBox = await box('synthetic-child');
    assert.ok(
      extremeChildBox.width >= 200,
      `The narrowed column must clamp at a content-safe minimum, got ${extremeChildBox.width}px`,
    );

    // Restore a normal split before the keyboard/double-click checks below.
    await handle.dblclick();
    await page.waitForTimeout(100);

    // Keyboard-accessible: focused handle, arrow keys resize.
    await handle.focus();
    const beforeArrowWidth = (await box('synthetic-child')).width;
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((prevWidth) => {
      const el = document.querySelector('#pane-synthetic-child');
      return !!el && Math.abs(el.getBoundingClientRect().width - prevWidth) > 1;
    }, beforeArrowWidth);

    // Double-click resets that pair of columns back to an equal split.
    await handle.dblclick();
    await page.waitForFunction(() => {
      const a = document.querySelector('#pane-synthetic-child')?.getBoundingClientRect().width;
      const b = document.querySelector('#pane-synthetic-reviewer')?.getBoundingClientRect().width;
      return !!a && !!b && Math.abs(a - b) < 3;
    });

    // Layout persists per room as UI metadata only — never transcripts.
    await page.waitForFunction(async (id) => {
      const state = await window.rooms.loadState();
      const room = (state.rooms || []).find((r) => r.id === id);
      return (
        room?.columns === 2 &&
        Array.isArray(room.columnWeights) &&
        room.columnWeights.length === 2
      );
    }, roomId);

    // Columns: 3 lays out three data columns with two handles when the window
    // is wide enough for each to keep a content-safe minimum width, still
    // contained (no page-level horizontal scroll), and never overlapping.
    // Widen the window first so three real columns actually fit — the default
    // 1280px window's content area (~716px) is not wide enough for three
    // managed-agent panes (with a usage badge) to each stay above the
    // content-safe minimum, and correctly degrades to two (checked below).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1680, 900);
    });
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Columns: 3' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.column-handle').length === 2);
    assert.ok(
      (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)),
      'Three-column layout must not cause page-level horizontal scroll',
    );
    await assertPanesDontOverlap('At Columns: 3 with room to spare');

    // The 3-column *setting* must also stay contained — and, above all, never
    // overlap — at the app's minimum window width. Three real columns cannot
    // each fit a content-safe minimum width there, so the app must fall back
    // to fewer effective columns (or none/one) rather than ever overlap panes
    // or clip a pane's status/close controls.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(860, 700);
    });
    await page.waitForTimeout(150);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'Three-column layout must stay contained at the 860px minimum window width',
    );
    await assertPanesDontOverlap('At Columns: 3, 860px minimum window width');
    const handlesAt860 = await page.locator('.column-handle').count();
    assert.ok(
      handlesAt860 < 2,
      'At 860px, three real columns cannot fit a content-safe minimum width, so the layout ' +
        'must fall back to fewer columns (fewer handles) instead of ever overlapping panes',
    );
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1280, 820);
    });
    await page.waitForTimeout(150);
    await assertPanesDontOverlap('Back at a comfortable window width');

    // Auto keeps the original responsive wrapping grid, with no handles.
    await page.getByRole('button', { name: 'Columns: auto' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.column-handle').length === 0);

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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1280, 820);
    });
    await page.waitForTimeout(150);

    // Persisted session history + Resume, in a fresh isolated room (so it never disturbs the
    // session ordering/counts the column-layout assertions above depend on). Never calls
    // runAgentTask/a real provider turn — createAgentSession only registers session metadata,
    // it never spawns or bills a model turn.
    await page.getByRole('button', { name: 'New room' }).click();
    await page.getByRole('heading', { name: 'This room is ready.' }).waitFor();
    const historyRoomId = await page.evaluate(async () => {
      const state = await window.rooms.loadState();
      return state.rooms.at(-1).id;
    });
    const resumable = {
      id: 'synthetic-resumable',
      roomId: historyRoomId,
      provider: 'claude',
      name: 'Claude resumable',
      status: 'idle',
      providerSessionId: 'demo-provider-session-abc123',
    };
    await registerRealSession(resumable);
    await send({ type: 'session-created', sessionId: resumable.id, roomId: historyRoomId, session: resumable });
    await page.getByText('Claude resumable', { exact: true }).first().waitFor();

    // Closing it records ended-session metadata (never a transcript) with the opaque
    // providerSessionId preserved, and shows a Resume action (never Reopen — that's terminal-only).
    await page.locator('#pane-synthetic-resumable .close-pane').click();
    await page.waitForFunction(() => !document.querySelector('#pane-synthetic-resumable'));
    const resumeRow = page.locator('.session-history-row', { hasText: 'Claude resumable' });
    await resumeRow.waitFor();
    await resumeRow.locator('.session-history-state', { hasText: 'ended · stopped' }).waitFor();
    const resumeButton = resumeRow.getByRole('button', { name: /Resume/ });
    await resumeButton.waitFor();
    assert.equal(
      await resumeRow.getByRole('button', { name: /Reopen/ }).count(),
      0,
      'A managed session history row must offer Resume, never Reopen',
    );

    // Resume: a brand-new engine session is created, seeded with the same opaque
    // providerSessionId, so the provider's own CLI resumes that conversation on its next task.
    await resumeButton.click();
    await page.getByText('Claude resumable', { exact: true }).first().waitFor();
    await page.getByText(/Claude resumable managed session created \(resumed\)\./, { exact: false }).waitFor();
    const resumedProviderSessionId = await page.evaluate(async (roomId) => {
      const state = await window.rooms.loadState();
      const room = (state.rooms || []).find((r) => r.id === roomId);
      const resumed = (room?.sessionHistory || []).find((e) => e.id === 'synthetic-resumable');
      return resumed?.providerSessionId;
    }, historyRoomId);
    assert.equal(
      resumedProviderSessionId,
      'demo-provider-session-abc123',
      'The opaque providerSessionId round-trips through persisted session history',
    );

    // Clear history removes the recovery list for this room (the resumed session itself is
    // live, not history, so nothing else in this room is affected).
    await page.getByRole('button', { name: /Clear history for/ }).click();
    await page.locator('.session-history').waitFor({ state: 'detached' });

    console.log(
      'PASS: synthetic managed-agent child session, lifecycle, transcript, activity, room policy UI, nested delegation view (by id, with provider), permission-denied warnings (incl. Cursor), rename (incl. blocked duplicate), safe Markdown transcript rendering (incl. inert script/img), provider-reported usage display and running totals, resizable/keyboard-accessible column layout with persistence, layout at the minimum window width, and persisted session history with Resume (opaque providerSessionId round-trip, synthetic engine, no real provider call).',
    );
  } finally {
    if (app) await app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
