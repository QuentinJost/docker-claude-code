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
