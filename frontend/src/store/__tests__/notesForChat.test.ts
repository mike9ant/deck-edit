import { describe, expect, it } from 'vitest'
import type { Note } from '../../api/types'
import { notesForChat, otherChatsNotes } from '../notesStore'

const note = (id: string, extra: Partial<Note> = {}): Note => ({
  id, deck: 'deck.pptx', slideId: '256', slideIndex: 1, x: 0.5, y: 0.5, text: id, author: 'user', createdAt: '', status: 'open', ...extra,
})

describe('notes per chat', () => {
  const notes = [
    note('old'), // from before chats: for every chat
    note('a', { chats: ['c1'] }),
    note('b', { chats: ['c2'] }),
    note('shared', { chats: ['c2', 'c1'] }),
    note('msg', { target: 'chat', slideId: 'c2', chats: ['c2'] }), // on a message of chat 2
    note('done', { chats: ['c2'], status: 'resolved' }),
  ]

  it("a chat's agent gets the notes taken in it or brought to it", () => {
    expect(notesForChat(notes, 'c1').map((n) => n.id)).toEqual(['old', 'a', 'shared'])
    expect(notesForChat(notes, 'c2').map((n) => n.id)).toEqual(['old', 'b', 'shared', 'msg', 'done'])
  })

  it("other chats' open notes can be brought over, but not notes on another chat's messages", () => {
    expect(otherChatsNotes(notes, 'c1').map((n) => n.id)).toEqual(['b'])
    expect(otherChatsNotes(notes, 'c2').map((n) => n.id)).toEqual(['a'])
  })
})
