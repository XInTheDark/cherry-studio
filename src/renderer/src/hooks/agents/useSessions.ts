import ConversationThreadService from '@renderer/services/ConversationThreadService'
import type { CreateAgentSessionResponse, CreateSessionForm, GetAgentSessionResponse } from '@renderer/types'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { useAgentClient } from './useAgentClient'

export const useSessions = (agentId: string | null) => {
  const { t } = useTranslation()
  const client = useAgentClient()
  const key = agentId ? client.getSessionPaths(agentId).base : null

  const fetcher = async () => {
    if (!agentId) throw new Error('No active agent.')
    const data = await client.listSessions(agentId)
    return data.data
  }
  const { data, error, isLoading, mutate } = useSWR(key, fetcher)

  useEffect(() => {
    if (!agentId || !data) return
    void ConversationThreadService.reconcileSessionThreadsForAgent({ agentId, sessions: data })
  }, [agentId, data])

  const createSession = useCallback(
    async (form: CreateSessionForm): Promise<CreateAgentSessionResponse | null> => {
      if (!agentId) return null
      try {
        const result = await client.createSession(agentId, form)
        await mutate((prev) => [result, ...(prev ?? [])], { revalidate: false })
        await ConversationThreadService.upsertSessionThread({ agentId, session: result })
        return result
      } catch (error) {
        window.toast.error(formatErrorMessageWithPrefix(error, t('agent.session.create.error.failed')))
        return null
      }
    },
    [agentId, client, mutate, t]
  )

  const getSession = useCallback(
    async (id: string): Promise<GetAgentSessionResponse | null> => {
      if (!agentId) return null
      try {
        const result = await client.getSession(agentId, id)
        mutate((prev) => prev?.map((session) => (session.id === result.id ? result : session)))
        await ConversationThreadService.upsertSessionThread({ agentId, session: result })
        return result
      } catch (error) {
        window.toast.error(formatErrorMessageWithPrefix(error, t('agent.session.get.error.failed')))
        return null
      }
    },
    [agentId, client, mutate, t]
  )

  const deleteSession = useCallback(
    async (id: string): Promise<boolean> => {
      if (!agentId) return false
      try {
        await client.deleteSession(agentId, id)
        mutate((prev) => prev?.filter((session) => session.id !== id))
        await ConversationThreadService.removeSessionThread(id)
        return true
      } catch (error) {
        window.toast.error(formatErrorMessageWithPrefix(error, t('agent.session.delete.error.failed')))
        return false
      }
    },
    [agentId, client, mutate, t]
  )

  return {
    sessions: data ?? [],
    error,
    isLoading,
    createSession,
    getSession,
    deleteSession
  }
}
