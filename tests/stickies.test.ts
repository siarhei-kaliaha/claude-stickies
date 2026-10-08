import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stickies',
  component: 'Pane',
  requestId: 'stickies',
  props: { title: 'Parked', isFocused: false, bodyColumns: 40 } as never,
} as const

test('a sticky shows in the pane and done removes it', async ($, on) => {
  mock.store(on)
  await $.tool.call({ tool: 'mcp__stickies__park', what: 'TASK-12 check comments' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /TASK-12/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const done = await ui.find({ type: 'Button', text: /done/ })
  await ui.press({ key: done?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /TASK-12/ })).toBeUndefined()
  await ui.unmount()
})

test('the park tool adds a sticky with where and next', async ($, on) => {
  mock.store(on)
  await $.tool.call({
    tool: 'mcp__stickies__park',
    what: 'TASK-7 recovery prompt',
    where: 'pull request open',
    next: 'check CI',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Markdown', text: /check CI/ })).toBeUndefined()
  const toggle = await ui.find({ type: 'Button', text: /▸/ })
  await ui.press({ key: toggle?.key ?? '' })
  expect(await ui.find({ type: 'Markdown', text: /check CI/ })).toBeDefined()
  await ui.unmount()
})

test('open_questions shows options as buttons, hides details until expand, and done removes a question', async ($, on) => {
  mock.store(on)
  on('ui.open', () => ({ value: {} }) as never)
  on('prompt.fill', () => ({ isFilled: true }) as never)
  await $.tool.call({
    tool: 'mcp__stickies__open_questions',
    questions: [
      { question: 'Merge PR 1?', details: 'CI is green.', options: ['Merge', 'Wait'] },
      { question: 'Delete the temp files?', options: ['Yes', 'No'] },
    ],
  })
  await $.tool.call({
    tool: 'mcp__stickies__open_questions',
    questions: [{ question: 'Delete the temp files?', details: 'They are not in git.', options: ['Yes', 'No'] }],
  })

  const ui = await $.ui.mount({ ...PANE, requestId: 'questions', surface: 'terminal' } as const)
  expect(await ui.find({ type: 'Text', text: /Merge PR 1/ })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: /not in git/ })).toBeUndefined()
  const toggle = await ui.find({ type: 'Button', text: /▸/ })
  await ui.press({ key: toggle?.key ?? '' })
  expect(await ui.find({ type: 'Markdown', text: /not in git/ })).toBeDefined()
  const yes = await ui.find({ type: 'Button', text: /^Yes$/ })
  await ui.press({ key: yes?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /→ Yes/ })).toBeDefined()
  const done = await ui.find({ type: 'Button', text: /done/ })
  await ui.press({ key: done?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /No open questions/ })).toBeDefined()
  await ui.unmount()
})
