export type Sticky = {
  id: string
  what: string
  where?: string
  next?: string
  parkedAt: number
}

export type Question = {
  id: string
  question: string
  details?: string
  options: string[]
  answer?: string
  askedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    stickies: { list: Sticky[]; questions: Question[]; expanded: string[] }
  }
}
