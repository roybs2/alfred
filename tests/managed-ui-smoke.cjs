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

    await send({
      type: 'delegation',
      sessionId: child.id,
      roomId,
      taskId: 'synthetic-task',
      targetSessionId: 'synthetic-reviewer',
      targetTaskId: 'synthetic-review-task',
      text: 'Codex child → Claude reviewer',
    });
    await page.getByText('Delegation: Codex child → Claude reviewer', { exact: true }).waitFor();

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
    console.log('PASS: synthetic managed-agent child session, lifecycle, transcript, activity, and room policy UI.');
  } finally {
    if (app) await app.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
