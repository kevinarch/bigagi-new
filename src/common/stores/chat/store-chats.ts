import { create } from 'zustand';
import { createJSONStorage, devtools, persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

import type { SystemPurposeId } from '../../../data';

import { DLLMId, findLLMOrThrow, getChatLLMId } from '~/modules/llms/store-llms';
import { convertDConversation_V3_V4 } from '~/modules/trade/trade.types';

import { agiId, agiUuid } from '~/common/util/idUtils';
import { backupIdbV3, idbStateStorage } from '~/common/util/idbUtils';

import type { DMessage, DMessageId, DMessageMetadata } from './chat.message';
import { conversationTitle, createDConversation, DConversation, DConversationId, duplicateCConversation } from './chat.conversation';
import { createErrorContentFragment, DMessageFragment, DMessageFragmentId, isContentFragment, isImageRefPart } from './chat.fragments';
import { estimateTokensForFragments } from './chat.tokens';


/// Conversations Store

interface ChatState {
  conversations: DConversation[];
}

export interface ChatActions {

  // CRUD conversations
  prependNewConversation: (personaId: SystemPurposeId | undefined) => DConversationId;
  importConversation: (c: DConversation, preventClash: boolean) => DConversationId;
  branchConversation: (cId: DConversationId, mId: DMessageId | null) => DConversationId | null;
  deleteConversations: (cIds: DConversationId[], newConversationPersonaId?: SystemPurposeId) => DConversationId;

  // within a conversation
  setAbortController: (cId: DConversationId, abortController: AbortController | null) => void;
  abortConversationTemp: (cId: DConversationId) => void;
  setMessages: (cId: DConversationId, messages: DMessage[]) => void;
  appendMessage: (cId: DConversationId, message: DMessage) => void;
  deleteMessage: (cId: DConversationId, mId: DMessageId) => void;
  editMessage: (cId: DConversationId, mId: DMessageId, update: Partial<DMessage> | ((message: DMessage) => Partial<DMessage>), removePendingState: boolean, touchUpdated: boolean) => void;
  appendMessageFragment: (cId: DConversationId, mId: DMessageId, fragment: DMessageFragment, removePendingState: boolean, touchUpdated: boolean) => void;
  deleteMessageFragment: (cId: DConversationId, mId: DMessageId, fId: DMessageFragmentId, removePendingState: boolean, touchUpdated: boolean) => void;
  replaceMessageFragment: (cId: DConversationId, mId: DMessageId, fId: DMessageFragmentId, newFragment: DMessageFragment, removePendingState: boolean, touchUpdated: boolean) => void;
  updateMetadata: (cId: DConversationId, mId: DMessageId, metadataDelta: Partial<DMessageMetadata>, touchUpdated?: boolean) => void;
  setSystemPurposeId: (cId: DConversationId, personaId: SystemPurposeId) => void;
  setAutoTitle: (cId: DConversationId, autoTitle: string) => void;
  setUserTitle: (cId: DConversationId, userTitle: string) => void;
  setUserSymbol: (cId: DConversationId, userSymbol: string | null) => void;

  // utility function
  _editConversation: (cId: DConversationId, update: Partial<DConversation> | ((conversation: DConversation) => Partial<DConversation>)) => void;
}

type ConversationsStore = ChatState & ChatActions;

const defaultConversations: DConversation[] = [createDConversation()];

export const useChatStore = create<ConversationsStore>()(devtools(
  persist(
    (_set, _get) => ({

      // default state
      conversations: defaultConversations,

      prependNewConversation: (personaId: SystemPurposeId | undefined): DConversationId => {
        const newConversation = createDConversation(personaId);

        _set(state => ({
          conversations: [newConversation, ...state.conversations],
        }));

        return newConversation.id;
      },

      importConversation: (conversation: DConversation, preventClash: boolean): DConversationId => {
        const { conversations } = _get();

        // if there's a clash, abort the former conversation, and optionally change the ID
        const existing = conversations.find(_c => _c.id === conversation.id);
        if (existing) {
          existing?.abortController?.abort();
          if (preventClash) {
            conversation.id = agiUuid('chat-dconversation');
            console.warn('Conversation ID clash, changing ID to', conversation.id);
          }
        }

        conversation.tokenCount = updateMessagesTokenCounts(conversation.messages, true, 'importConversation');

        _set({
          conversations: [conversation, ...conversations.filter(_c => _c.id !== conversation.id)],
        });

        return conversation.id;
      },

      branchConversation: (conversationId: DConversationId, messageId: DMessageId | null): DConversationId | null => {
        const { conversations } = _get();
        const conversation = conversations.find(_c => _c.id === conversationId);
        if (!conversation)
          return null;

        const branched = duplicateCConversation(conversation, messageId ?? undefined);

        _set({
          conversations: [branched, ...conversations],
        });

        return branched.id;
      },

      deleteConversations: (conversationIds: DConversationId[], newConversationPersonaId?: SystemPurposeId): DConversationId => {
        const { conversations } = _get();

        // find the index of first conversation to delete
        const cIndex = conversationIds.length > 0 ? conversations.findIndex(_c => _c.id === conversationIds[0]) : -1;

        // abort all pending requests
        conversationIds.forEach(conversationId => conversations.find(_c => _c.id === conversationId)?.abortController?.abort());

        // remove from the list
        const newConversations = conversations.filter(_c => !conversationIds.includes(_c.id));

        // create a new conversation if there are no more
        if (!newConversations.length)
          newConversations.push(createDConversation(newConversationPersonaId));

        _set({
          conversations: newConversations,
        });

        // return the next conversation Id in line, if valid
        return newConversations[(cIndex >= 0 && cIndex < newConversations.length) ? cIndex : 0].id;
      },


      // within a conversation

      _editConversation: (conversationId: DConversationId, update: Partial<DConversation> | ((conversation: DConversation) => Partial<DConversation>)) =>
        _set(state => ({
          conversations: state.conversations.map((conversation): DConversation =>
            conversation.id === conversationId
              ? {
                ...conversation,
                ...(typeof update === 'function' ? update(conversation) : update),
              }
              : conversation,
          ),
        })),

      setAbortController: (conversationId: DConversationId, abortController: AbortController | null) =>
        _get()._editConversation(conversationId, () =>
          ({
            abortController: abortController,
          })),

      abortConversationTemp: (conversationId: DConversationId) =>
        _get()._editConversation(conversationId, conversation => {
          conversation.abortController?.abort();
          return {
            abortController: null,
          };
        }),

      setMessages: (conversationId: DConversationId, newMessages: DMessage[]) =>
        _get()._editConversation(conversationId, conversation => {
          conversation.abortController?.abort();
          return {
            messages: newMessages,
            ...(!!newMessages.length ? {} : {
              autoTitle: undefined,
            }),
            tokenCount: updateMessagesTokenCounts(newMessages, false, 'setMessages'),
            updated: Date.now(),
            abortController: null,
          };
        }),

      appendMessage: (conversationId: DConversationId, message: DMessage) =>
        _get()._editConversation(conversationId, conversation => {

          if (!message.pendingIncomplete)
            updateMessagesTokenCounts([message], true, 'appendMessage');

          const messages = [...conversation.messages, message];

          return {
            messages,
            tokenCount: messages.reduce((sum, message) => sum + 4 + message.tokenCount || 0, 3),
            updated: Date.now(),
          };
        }),

      deleteMessage: (conversationId: DConversationId, messageId: DMessageId) =>
        _get()._editConversation(conversationId, conversation => {

          const messages = conversation.messages.filter(message => message.id !== messageId);

          return {
            messages,
            tokenCount: messages.reduce((sum, message) => sum + 4 + message.tokenCount || 0, 3),
            updated: Date.now(),
          };
        }),

      editMessage: (conversationId: DConversationId, messageId: DMessageId, update: Partial<DMessage> | ((message: DMessage) => Partial<DMessage>), removePendingState: boolean, touchUpdated: boolean) =>
        _get()._editConversation(conversationId, conversation => {

          const messages = conversation.messages.map((message): DMessage => {
            if (message.id !== messageId)
              return message;

            const updatedMessage: DMessage = {
              ...message,
              ...(typeof update === 'function' ? update(message) : update),
              ...(touchUpdated && { updated: Date.now() }),
            };

            if (removePendingState)
              delete updatedMessage.pendingIncomplete;

            if (!updatedMessage.pendingIncomplete)
              updateMessageTokenCount(updatedMessage, getChatLLMId(), true, 'editMessage(incomplete=false)');

            return updatedMessage;
          });

          return {
            messages,
            tokenCount: messages.reduce((sum, message) => sum + 4 + message.tokenCount || 0, 3),
            updated: touchUpdated ? Date.now() : conversation.updated,
          };
        }),

      appendMessageFragment: (conversationId: DConversationId, messageId: DMessageId, fragment: DMessageFragment, removePendingState: boolean, touchUpdated: boolean) =>
        _get().editMessage(conversationId, messageId, message => ({
          fragments: [...message.fragments, fragment],
        }), removePendingState, touchUpdated),

      deleteMessageFragment: (conversationId: DConversationId, messageId: DMessageId, fragmentId: DMessageFragmentId, removePendingState: boolean, touchUpdated: boolean) =>
        _get().editMessage(conversationId, messageId, message => ({
          fragments: message.fragments.filter(f => f.fId !== fragmentId),
        }), removePendingState, touchUpdated),

      replaceMessageFragment: (conversationId: DConversationId, messageId: DMessageId, fragmentId: DMessageFragmentId, newFragment: DMessageFragment, removePendingState: boolean, touchUpdated: boolean) =>
        _get().editMessage(conversationId, messageId, message => {

          // Warn if the fragment is not found
          const fragmentIndex = message.fragments.findIndex(f => f.fId === fragmentId);
          if (fragmentIndex < 0) {
            console.error(`replaceFragment: fragment not found for ID ${fragmentId}`);
            return {};
          }

          // Replace the fragment
          return {
            fragments: message.fragments.map((fragment, index) =>
              (index === fragmentIndex)
                ? { ...newFragment } // force the object tree to change, just in case the contents changed but not the object reference
                : fragment,
            ),
          };
        }, removePendingState, touchUpdated),

      updateMetadata: (conversationId: DConversationId, messageId: DMessageId, metadataDelta: Partial<DMessageMetadata>, touchUpdated: boolean = true) => {
        _get()._editConversation(conversationId, conversation => {
          const messages = conversation.messages.map(message =>
            message.id !== messageId ? message
              : {
                ...message,
                metadata: {
                  ...message.metadata,
                  ...metadataDelta,
                },
                updated: touchUpdated ? Date.now() : message.updated,
              },
          );

          return {
            messages,
            updated: touchUpdated ? Date.now() : conversation.updated,
          };
        });
      },

      setSystemPurposeId: (conversationId: DConversationId, personaId: SystemPurposeId) =>
        _get()._editConversation(conversationId,
          {
            systemPurposeId: personaId,
          }),

      setAutoTitle: (conversationId: DConversationId, autoTitle: string) =>
        _get()._editConversation(conversationId,
          {
            autoTitle,
          }),

      setUserTitle: (conversationId: DConversationId, userTitle: string) =>
        _get()._editConversation(conversationId,
          {
            userTitle,
          }),

      setUserSymbol: (conversationId: DConversationId, userSymbol: string | null) =>
        _get()._editConversation(conversationId,
          {
            userSymbol: userSymbol || undefined,
          }),

    }),
    {
      name: 'app-chats',
      /* Version history:
       *  - 1: [2023-03-18] App launch, single chat
       *  - 2: [2023-04-10] Multi-chat version - invalidating data to be sure
       *  - 3: [2023-09-19] Switch to IndexedDB - no data shape change,
       *                    but we swapped the backend (localStorage -> IndexedDB)
       *  - 4: [2024-05-14] Convert messages to multi-part, removed the IDB migration
       */
      version: 4,
      storage: createJSONStorage(() => idbStateStorage),

      // Migrations
      migrate: async (state: any, fromVersion: number) => {

        // 3 -> 4: Convert messages to multi-part
        if (fromVersion < 4 && state && state.conversations && state.conversations.length) {
          if (await backupIdbV3('app-chats', 'app-chats-v3'))
            console.warn('Migrated app-chats from v3 to v4');
          state.conversations = state.conversations?.map(convertDConversation_V3_V4) || [];
        }

        return state;
      },

      // Pre-Saving: remove transient properties
      partialize: (state) => ({
        ...state,
        conversations: state.conversations.map((conversation: DConversation) => {
          const { abortController, ...rest } = conversation;
          return rest;
        }),
      }),

      // Post-Loading: re-add transient properties and cleanup state
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        // fixup conversations
        for (const conversation of (state.conversations || [])) {
          // re-add transient properties
          conversation.abortController = null;
          // fixup messages
          for (const message of conversation.messages) {
            // cleanup within-v4 - TODO: remove at 2.0.0 ?
            for (const fragment of message.fragments) {
              // fixup rename of fragment's dblobId to dblobAssetId
              if (isContentFragment(fragment) && isImageRefPart(fragment.part) && fragment.part.dataRef.reftype === 'dblob' && (fragment.part.dataRef as any)['dblobId']) {
                fragment.part.dataRef.dblobAssetId = (fragment.part.dataRef as any)['dblobId'];
                delete (fragment.part.dataRef as any)['dblobId'];
              }
              // fixup missing fId
              if (!fragment.fId) {
                fragment.fId = agiId('chat-dfragment');
              }
            }
            // replace the Content.Pl[part.pt='ph'] fragments with Error fragments, to show the aborted ops (instead of just empty blocks)
            message.fragments = message.fragments.map((fragment: DMessageFragment): DMessageFragment =>
              (isContentFragment(fragment) && fragment.part.pt === 'ph')
                ? createErrorContentFragment(`${fragment.part.pText} (did not complete)`)
                : fragment,
            );
            // cleanup pre-v4 properties
            delete message.pendingIncomplete;
            delete (message as any).typing;
          }
        }
      },

    }),
  {
    name: 'AppChats',
    enabled: false,
  }),
);


// Convenience function to update a set of messages, using the current chatLLM
function updateMessagesTokenCounts(messages: DMessage[], forceUpdate: boolean, debugFrom: string): number {
  const chatLLMId = getChatLLMId();
  return 3 + messages.reduce((sum, message) => {
    return 4 + updateMessageTokenCount(message, chatLLMId, forceUpdate, debugFrom) + sum;
  }, 0);
}

// Convenience function to count the tokens in a DMessage object
function updateMessageTokenCount(message: DMessage, llmId: DLLMId | null, forceUpdate: boolean, debugFrom: string): number {
  if (forceUpdate || !message.tokenCount) {
    // if there's no LLM, we can't count tokens
    if (!llmId) {
      message.tokenCount = 0;
      return 0;
    }

    // find the LLM from the ID
    try {
      const dllm = findLLMOrThrow(llmId);
      message.tokenCount = estimateTokensForFragments(message.fragments, dllm, false, debugFrom);
    } catch (e) {
      console.error(`updateMessageTokenCount: LLM not found for ID ${llmId}`);
      message.tokenCount = 0;
    }
  }
  return message.tokenCount;
}


export function isValidConversation(conversationId?: DConversationId | null): conversationId is DConversationId {
  return !!conversationId && getConversation(conversationId) !== null;
}

export function getConversation(conversationId: DConversationId | null): DConversation | null {
  return conversationId ? useChatStore.getState().conversations.find(_c => _c.id === conversationId) ?? null : null;
}

export function getConversationSystemPurposeId(conversationId: DConversationId | null): SystemPurposeId | null {
  return getConversation(conversationId)?.systemPurposeId || null;
}


export const useConversation = (conversationId: DConversationId | null) => useChatStore(useShallow(state => {
  const { conversations } = state;

  // this object will change if any sub-prop changes as well
  const conversation = conversationId ? conversations.find(_c => _c.id === conversationId) ?? null : null;
  const title = conversation ? conversationTitle(conversation) : null;
  const isEmpty = conversation ? !conversation.messages.length : true;
  const isDeveloper = conversation?.systemPurposeId === 'Developer';
  const conversationIdx = conversation ? conversations.findIndex(_c => _c.id === conversation.id) : -1;

  const hasConversations = conversations.length > 1 || (conversations.length === 1 && !!conversations[0].messages.length);
  const recycleNewConversationId = (conversations.length && !conversations[0].messages.length) ? conversations[0].id : null;

  return {
    title,
    isEmpty,
    isDeveloper,
    conversationIdx,
    hasConversations,
    recycleNewConversationId,
    prependNewConversation: state.prependNewConversation,
    branchConversation: state.branchConversation,
    deleteConversations: state.deleteConversations,
  };
}));
