import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Question, Sticky } from '../types'

type Engine = EngineInterface

const PANE = 'stickies'
const PARK_TOOL = 'mcp__stickies__park'
const CROWDED = 7
const QUESTIONS_PANE = 'questions'
const QUESTIONS_TOOL = 'mcp__stickies__open_questions'
const QUESTIONS_GUIDE = [
  'The user has a side pane named "Open questions". It shows the questions that you asked and the user did not answer.',
  `- When your reply has a question that the user must answer, or a decision that only the user can make, call the ${QUESTIONS_TOOL} tool before you end the turn.`,
  '- Send the full current list in each call. The call replaces the list.',
  '- Remove a question when the user answers it or when it does not apply now. Send an empty list when no question is open.',
  '- `question` is a summary of maximum 60 characters. The user reads only this line until they expand the item.',
  '- `details` has the facts that the user needs for the answer, in Markdown. The pane hides it until the user expands the item.',
  '- `options` has 2 to 4 short answers. The pane shows each one as a button. Put the answer that you recommend first.',
  '- Do not add a question that you can answer yourself.',
].join('\n')
const PARK_PROMPT =
  `Call the ${PARK_TOOL} tool now. Give a short name of the current work, the point where the work stopped, ` +
  'and the next step. Use a bullet list for 2 or more items. Then stop.'

const stickies = atom({ plugin: 'stickies', key: 'list' } as const, [])

const questions = atom({ plugin: 'stickies', key: 'questions' } as const, [])
const expanded = atom({ plugin: 'stickies', key: 'expanded' } as const, [])

let storeKey = 'stickies:unknown'

const changeQuestions = async ($: Engine, fn: (list: Question[]) => Question[]) => {
  await update($, questions, list => fn(list ?? []))
  await $.store.set(`${storeKey}:questions`, await read($, questions))
}

const change = async ($: Engine, fn: (list: Sticky[]) => Sticky[]) => {
  await update($, stickies, list => fn(list ?? []))
  await $.store.set(storeKey, await read($, stickies))
}

const add = ($: Engine, sticky: Omit<Sticky, 'id' | 'parkedAt'>) => {
  const parkedAt = Date.now()

  return change($, list => [
    ...list.filter(one => one.what !== sticky.what),
    { ...sticky, id: `${parkedAt}-${list.length}`, parkedAt },
  ])
}

const age = (parkedAt: number) => {
  const minutes = Math.floor((Date.now() - parkedAt) / 60_000)
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`

  return `${Math.floor(minutes / (60 * 24))}d`
}

const resumeText = (sticky: Sticky) =>
  [
    `Resume: ${sticky.what}.`,
    sticky.where && `We stopped at: ${sticky.where}.`,
    sticky.next && `Next step: ${sticky.next}.`,
  ]
    .filter(Boolean)
    .join(' ')

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    storeKey = `stickies:${await $.session.id()}`

    const saved = await $.store.get(storeKey)
    await update($, stickies, () => (Array.isArray(saved) ? (saved as Sticky[]) : []))

    const savedQuestions = await $.store.get(`${storeKey}:questions`)
    await update($, questions, () => (Array.isArray(savedQuestions) ? (savedQuestions as Question[]) : []))

    await $.command.register({ name: 'questions', description: 'Show the questions that Claude waits for' })
    await $.tool.register({
      name: 'open_questions',
      description:
        'Replaces the list in the "Open questions" side pane. The pane shows the questions that the user must answer. ' +
        'Send the full current list. Send an empty list when no question is open.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'A summary of the question. Maximum 60 characters.' },
                details: {
                  type: 'string',
                  description: 'The facts that the user needs for the answer. Use Markdown. The pane shows it on expand.',
                },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '2 to 4 short answers. Each one becomes a button. Put the recommended answer first.',
                },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    })
    await $.command.register({ name: 'stickies', description: 'Show the parked work of this session' })
    await $.command.register({ name: 'note', description: 'Add a sticky by hand: /note text' })
    await $.command.register({ name: 'park', description: 'Ask Claude to park the current work on a sticky' })
    await $.tool.register({
      name: 'park',
      description:
        'Saves the current work as a sticky note in the side pane. The user reads the note later and continues the work. ' +
        'A note with the same `what` replaces the old note.',
      inputSchema: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            description: 'A short name of the work. Maximum 60 characters. Put the ticket id first if there is one.',
          },
          where: {
            type: 'string',
            description: 'The point where the work stopped. Use Markdown. Use a bullet list for 2 or more items.',
          },
          next: {
            type: 'string',
            description: 'The next step. Use Markdown. Use a bullet list for 2 or more steps.',
          },
        },
        required: ['what'],
      },
    })
    void $.ui.open({ id: PANE, title: 'Parked' })

    return next(e)
  })

  on('command.run', { command: 'questions' }, async $ => {
    await $.ui.open({ id: QUESTIONS_PANE, title: 'Open questions' })

    return { text: 'Open questions pane opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      ...composed,
      sections: [...composed.sections, { id: 'stickies-open-questions', text: QUESTIONS_GUIDE, scope: 'session' }],
    }
  })

  on('tool.call', { tool: QUESTIONS_TOOL }, async ($, e) => {
    const asked = Array.isArray(e.questions)
      ? (e.questions as { question?: unknown; details?: unknown; options?: unknown }[])
      : []
    const now = Date.now()
    await changeQuestions($, old =>
      asked.flatMap((one, index) => {
        const question = text(one.question)
        if (question === undefined) return []
        const before = old.find(item => item.question === question)

        const options = Array.isArray(one.options) ? one.options.flatMap(option => text(option) ?? []) : []

        return [
          {
            id: before?.id ?? `${now}-${index}`,
            question,
            details: text(one.details),
            options,
            answer: before?.answer,
            askedAt: before?.askedAt ?? now,
          },
        ]
      }),
    )
    const count = ((await read($, questions)) ?? []).length
    if (count > 0) void $.ui.open({ id: QUESTIONS_PANE, title: 'Open questions' })

    return { result: `Open questions: ${count}` }
  })

  on('ui.render', { component: 'Pane', requestId: QUESTIONS_PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = (await read($, questions)) ?? []
    const open = (await read($, expanded)) ?? []
    const answer = (one: Question, chosen: string) => {
      void $.prompt.fill({ text: `${one.question} → ${chosen}\n`, mode: 'append' })
      void changeQuestions($, all => all.map(item => (item.id === one.id ? { ...item, answer: chosen } : item)))
    }

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No open questions.</Text>}
        {list.map((one, index) => {
          const isOpen = open.includes(one.id)

          return (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Box gap={1}>
                <Button
                  key={`toggle:${one.id}`}
                  plain
                  onPress={() =>
                    void update($, expanded, ids =>
                      (ids ?? []).includes(one.id) ? (ids ?? []).filter(id => id !== one.id) : [...(ids ?? []), one.id],
                    )
                  }
                >
                  {isOpen ? '▾' : '▸'}
                </Button>
                <Text bold dimColor={one.answer !== undefined}>
                  {index + 1}. {one.question}
                </Text>
              </Box>
              {isOpen && one.details && <Markdown text={one.details} />}
              {one.answer !== undefined && <Text color="success">→ {one.answer}</Text>}
              {one.answer === undefined &&
                (one.options ?? []).map((option, at) => (
                  <Button
                    key={`option:${one.id}:${at}`}
                    variant={at === 0 ? 'primary' : 'secondary'}
                    onPress={() => answer(one, option)}
                  >
                    {option}
                  </Button>
                ))}
              <Box gap={1}>
                <Text dimColor>{age(one.askedAt)} ago</Text>
                <Button
                  key={`other:${one.id}`}
                  onPress={() => void $.prompt.fill({ text: `${one.question} → `, mode: 'append' })}
                >
                  other
                </Button>
                <Button
                  key={`drop:${one.id}`}
                  onPress={() => void changeQuestions($, all => all.filter(item => item.id !== one.id))}
                >
                  done
                </Button>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })

  on('command.run', { command: 'stickies' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Parked' })

    return { text: 'Parked pane opened.' }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const what = text(e.args)
    if (what === undefined) return { text: 'Usage: /note text' }
    await add($, { what })
    await $.ui.open({ id: PANE, title: 'Parked' })

    return { text: `Sticky added: ${what}` }
  })

  on('command.run', { command: 'park' }, async $ => {
    void $.prompt
      .submit({ text: PARK_PROMPT, asUser: true })
      .catch(error => $.ui.toast(`stickies: /park could not reach Claude: ${String(error)}`))
    await $.ui.open({ id: PANE, title: 'Parked' })

    return { text: 'Parking the current work.' }
  })

  on('tool.call', { tool: PARK_TOOL }, async ($, e) => {
    const what = text(e.what)
    if (what === undefined) return { deny: 'park needs "what".' }
    await add($, { what, where: text(e.where), next: text(e.next) })

    return { result: `Parked: ${what}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = (await read($, stickies)) ?? []
    const stale = list.length - CROWDED
    const open = (await read($, expanded)) ?? []

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>Nothing parked. /park or /note text</Text>}
        {list.map((sticky, index) => {
          const isOpen = open.includes(sticky.id)

          return (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={index < stale ? 'warning' : undefined}
            borderDimColor={index >= stale}
            paddingX={1}
          >
            <Text bold>{sticky.what}</Text>
            {isOpen && sticky.where && <Text dimColor>STOPPED</Text>}
            {isOpen && sticky.where && <Markdown text={sticky.where} />}
            {isOpen && sticky.next && <Text dimColor>NEXT</Text>}
            {isOpen && sticky.next && <Markdown text={sticky.next} />}
            <Box gap={1}>
              <Text dimColor>{age(sticky.parkedAt)} ago</Text>
              {(sticky.where || sticky.next) && (
                <Button
                  key={`toggle:${sticky.id}`}
                  onPress={() =>
                    void update($, expanded, ids =>
                      (ids ?? []).includes(sticky.id)
                        ? (ids ?? []).filter(id => id !== sticky.id)
                        : [...(ids ?? []), sticky.id],
                    )
                  }
                >
                  {isOpen ? '▾ hide' : '▸ show'}
                </Button>
              )}
              <Button
                key={`resume:${sticky.id}`}
                onPress={() => void $.prompt.fill({ text: resumeText(sticky), mode: 'replace' })}
              >
                resume
              </Button>
              <Button
                key={`done:${sticky.id}`}
                onPress={() => void change($, all => all.filter(one => one.id !== sticky.id))}
              >
                done
              </Button>
            </Box>
          </Box>
          )
        })}
        {stale > 0 && <Text color="warning">{list.length} stickies: finish or drop the old ones.</Text>}
      </Box>
    )
  })
}
