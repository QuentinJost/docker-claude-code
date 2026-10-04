import type { Peer } from '../types'

const PEER_ROW = /^\s+(\S+) \[([0-9a-f]+)\]\s+·\s+(\S+)\s+·\s+(\S+)\s+·\s+started (.+?)\s*$/
const SELF_ROW = /This session is (\S+) \[[0-9a-f]+\]/

/** Reads the ListAgents listing: this session's name and its peer sessions. */
export const parseListing = (listing: string): { self: string; peers: Peer[] } => {
  const self = SELF_ROW.exec(listing)?.[1] ?? ''
  const peers: Peer[] = []

  for (const line of listing.split('\n')) {
    const [, name, ref, kind, status, started] = PEER_ROW.exec(line) ?? []
    if (name && ref && kind && status && started) {
      peers.push({ name, ref, kind, status, started: started.replace(/ ago$/, '') })
    }
  }

  return { self, peers }
}

const FROM_NAME = /from-name="([^"]+)"/
const IDLE_NOTICE = /^\[Cross-session idle notice\] "([^"]+)"/

/** Names the session an inbound delivery comes from. */
export const parseInbound = (text: string): { peer: string; isIdleNotice: boolean } => {
  const idlePeer = IDLE_NOTICE.exec(text)?.[1]
  if (idlePeer) {
    return { peer: idlePeer, isIdleNotice: true }
  }

  return { peer: FROM_NAME.exec(text)?.[1] ?? '?', isIdleNotice: false }
}

/** Strips the cross-session envelope and folds the body into one line. */
export const oneLine = (text: string): string =>
  text
    .replace(/<\/?cross-session-message[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The message body without its cross-session envelope, lines kept. */
export const body = (text: string): string => text.replace(/<\/?cross-session-message[^>]*>/g, '').trim()

const BACKGROUNDED = /backgrounded · ([0-9a-f]+) · (\S+)/

/** Reads the id `claude --bg` prints, what `claude attach` takes. */
export const parseBackgrounded = (stdout: string): { id: string; name: string } | null => {
  const [, id, name] = BACKGROUNDED.exec(stdout.replace(/\x1b\[[0-9;]*m/g, '')) ?? []
  return id && name ? { id, name } : null
}

type SendAnswer = { success?: unknown; message?: unknown }

const answerOf = (value: unknown): SendAnswer | null => {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  return parsed !== null && typeof parsed === 'object' ? (parsed as SendAnswer) : null
}

/**
 * Why a SendMessage call delivered nothing, or null when it was delivered. An unreachable name
 * comes back as an ordinary result, `{ success: false, message }`, with neither a refusal nor the
 * error flag (seen from a plugin on 2026-10-03), so that field decides; a refusal or an error
 * counts as well. The reason is the message's first line.
 */
export const deliveryFailure = (ran: { deny?: string; isError?: boolean; result?: unknown; text?: string }): string | null => {
  if (ran.deny !== undefined) {
    return ran.deny
  }
  const answer = answerOf(ran.result) ?? answerOf(ran.text)
  if (answer?.success === false) {
    const message = typeof answer.message === 'string' ? answer.message.split('\n')[0]?.trim() : ''
    return message || 'not delivered'
  }

  return ran.isError ? ran.text || 'the tool reported an error' : null
}

/**
 * Whether a failed send was held by the auto-mode classifier rather than refused or undeliverable:
 * it gives no verdict on a plugin's own SendMessage when no prompt of the person's asked for one
 * (a `/orch` command is not read as one; seen 2026-10-03). Such a send may pass on a second try,
 * or when the model makes it.
 */
export const isAutoModeHold = (reason: string): boolean => /auto mode/i.test(reason) && /classifier/i.test(reason)
