import store, { useAppSelector } from '@renderer/store'
import { IpcChannel } from '@shared/IpcChannel'
import { useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useLocation, useNavigate } from 'react-router-dom'

const NavigationHandler: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const showSettingsShortcutEnabled = useAppSelector(
    (state) => state.shortcuts.shortcuts.find((s) => s.key === 'show_settings')?.enabled
  )

  useHotkeys(
    'meta+, ! ctrl+,',
    function () {
      if (location.pathname.startsWith('/settings')) {
        return
      }
      navigate('/settings/provider')
    },
    {
      splitKey: '!',
      enableOnContentEditable: true,
      enableOnFormTags: true,
      enabled: showSettingsShortcutEnabled
    }
  )

  // Listen for navigate to About page event from macOS menu
  useEffect(() => {
    const handleNavigateToAbout = () => {
      navigate('/settings/about')
    }

    const removeListener = window.electron.ipcRenderer.on(IpcChannel.Windows_NavigateToAbout, handleNavigateToAbout)

    return () => {
      removeListener()
    }
  }, [navigate])

  // Mini-window can request opening a newly created topic in the main window.
  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      IpcChannel.App_OpenTopic,
      (_event, payload: { assistantId: string; topicId: string }) => {
        const state = store.getState()
        const assistant = state.assistants.assistants.find((a) => a.id === payload.assistantId)
        const topic = assistant?.topics.find((t) => t.id === payload.topicId)
        if (assistant && topic) {
          navigate('/', { state: { assistant, topic } })
        } else if (assistant) {
          navigate('/', { state: { assistant } })
        } else {
          navigate('/')
        }
      }
    )

    return () => {
      removeListener()
    }
  }, [navigate])

  // Mini-window can request navigation to a route in the main window.
  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(IpcChannel.App_Navigate, (_event, path: string) => {
      if (typeof path === 'string' && path.trim()) {
        navigate(path)
      }
    })

    return () => {
      removeListener()
    }
  }, [navigate])

  return null
}

export default NavigationHandler
