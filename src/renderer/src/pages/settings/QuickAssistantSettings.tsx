import { InfoCircleOutlined } from '@ant-design/icons'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { HStack } from '@renderer/components/Layout'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useAssistants, useDefaultAssistant, useDefaultModel } from '@renderer/hooks/useAssistant'
import { useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setQuickAssistantId } from '@renderer/store/llm'
import type { QuickAssistantCommand } from '@renderer/store/settings'
import {
  DEFAULT_QUICK_ASSISTANT_COMMANDS,
  setClickTrayToShowQuickAssistant,
  setEnableQuickAssistant,
  setQuickAssistantCommands,
  setReadClipboardAtStartup
} from '@renderer/store/settings'
import { matchKeywordsInString, uuid } from '@renderer/utils'
import HomeWindow from '@renderer/windows/mini/home/HomeWindow'
import { Button, Input, Modal, Select, Space, Switch, Tooltip } from 'antd'
import { Dices, OctagonX } from 'lucide-react'
import { DynamicIcon, iconNames } from 'lucide-react/dynamic'
import type { FC } from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingContainer, SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '.'

const isLucideIconName = (icon: string): icon is (typeof iconNames)[number] =>
  iconNames.includes(icon as (typeof iconNames)[number])
const QuickAssistantSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { enableQuickAssistant, clickTrayToShowQuickAssistant, setTray, readClipboardAtStartup, defaultAssistantId } =
    useSettings()
  const dispatch = useAppDispatch()
  const { assistants } = useAssistants()
  const { quickAssistantId } = useAppSelector((state) => state.llm)
  const quickAssistantCommands =
    useAppSelector((state) => state.settings.quickAssistantCommands) || DEFAULT_QUICK_ASSISTANT_COMMANDS
  const { defaultAssistant: legacyDefaultAssistant } = useDefaultAssistant()
  const { defaultModel } = useDefaultModel()

  const [commandModalOpen, setCommandModalOpen] = useState(false)
  const [editingCommand, setEditingCommand] = useState<QuickAssistantCommand | null>(null)
  const [commandTitle, setCommandTitle] = useState('')
  const [commandPrompt, setCommandPrompt] = useState('')
  const [commandIcon, setCommandIcon] = useState('')
  const [commandIconError, setCommandIconError] = useState('')
  const [commandHideSource, setCommandHideSource] = useState(true)

  // Use the selected default assistant (from settings) when present.
  const defaultAssistant = useMemo(() => {
    return (
      assistants.find((a) => a.id === defaultAssistantId) ??
      assistants.find((a) => a.id === legacyDefaultAssistant.id) ??
      legacyDefaultAssistant
    )
  }, [assistants, defaultAssistantId, legacyDefaultAssistant])

  const updateCommands = (next: QuickAssistantCommand[]) => {
    dispatch(setQuickAssistantCommands(next))
  }

  const moveCommand = (id: string, direction: 'up' | 'down') => {
    const index = quickAssistantCommands.findIndex((c) => c.id === id)
    if (index === -1) return
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= quickAssistantCommands.length) return

    const next = [...quickAssistantCommands]
    const [item] = next.splice(index, 1)
    next.splice(nextIndex, 0, item)
    updateCommands(next)
  }

  const openAddCommand = () => {
    setEditingCommand(null)
    setCommandTitle('')
    setCommandPrompt('')
    setCommandIcon('')
    setCommandIconError('')
    setCommandHideSource(true)
    setCommandModalOpen(true)
  }

  const openEditCommand = (command: QuickAssistantCommand) => {
    setEditingCommand(command)
    setCommandTitle(command.title || '')
    setCommandPrompt(command.prompt || '')
    setCommandIcon(command.icon || '')
    setCommandIconError('')
    setCommandHideSource(!!command.hideSourceMessage)
    setCommandModalOpen(true)
  }

  const saveCommand = () => {
    const trimmedTitle = commandTitle.trim()
    const trimmedPrompt = commandPrompt.trim()
    const trimmedIcon = commandIcon.trim()

    if (!trimmedTitle || !trimmedPrompt) return
    if (trimmedIcon && !isLucideIconName(trimmedIcon)) {
      setCommandIconError('Invalid icon name')
      return
    }

    if (editingCommand) {
      updateCommands(
        quickAssistantCommands.map((c) =>
          c.id === editingCommand.id
            ? {
                ...c,
                title: trimmedTitle,
                prompt: trimmedPrompt,
                icon: trimmedIcon || undefined,
                hideSourceMessage: commandHideSource
              }
            : c
        )
      )
    } else {
      const newCommand: QuickAssistantCommand = {
        id: uuid(),
        type: 'prompt',
        title: trimmedTitle,
        prompt: trimmedPrompt,
        icon: trimmedIcon || undefined,
        enabled: true,
        hideSourceMessage: commandHideSource,
        isBuiltIn: false
      }
      updateCommands([...quickAssistantCommands, newCommand])
    }

    setCommandModalOpen(false)
  }

  const handleEnableQuickAssistant = async (enable: boolean) => {
    dispatch(setEnableQuickAssistant(enable))
    await window.api.config.set('enableQuickAssistant', enable, true)

    !enable && window.api.miniWindow.close()

    if (enable && !clickTrayToShowQuickAssistant) {
      window.toast.info({
        title: t('settings.quickAssistant.use_shortcut_to_show'),
        timeout: 4000,
        icon: <InfoCircleOutlined />
      })
    }

    if (enable && clickTrayToShowQuickAssistant) {
      setTray(true)
    }
  }

  const handleClickTrayToShowQuickAssistant = async (checked: boolean) => {
    dispatch(setClickTrayToShowQuickAssistant(checked))
    await window.api.config.set('clickTrayToShowQuickAssistant', checked)
    checked && setTray(true)
  }

  const handleClickReadClipboardAtStartup = async (checked: boolean) => {
    dispatch(setReadClipboardAtStartup(checked))
    await window.api.config.set('readClipboardAtStartup', checked)
    window.api.miniWindow.close()
  }

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.quickAssistant.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>{t('settings.quickAssistant.enable_quick_assistant')}</span>
            <Tooltip title={t('settings.quickAssistant.use_shortcut_to_show')} placement="right">
              <InfoCircleOutlined style={{ cursor: 'pointer' }} />
            </Tooltip>
          </SettingRowTitle>
          <Switch checked={enableQuickAssistant} onChange={handleEnableQuickAssistant} />
        </SettingRow>
        {enableQuickAssistant && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.quickAssistant.click_tray_to_show')}</SettingRowTitle>
              <Switch checked={clickTrayToShowQuickAssistant} onChange={handleClickTrayToShowQuickAssistant} />
            </SettingRow>
          </>
        )}
        {enableQuickAssistant && (
          <>
            <SettingDivider />
            <SettingRow>
              <SettingRowTitle>{t('settings.quickAssistant.read_clipboard_at_startup')}</SettingRowTitle>
              <Switch checked={readClipboardAtStartup} onChange={handleClickReadClipboardAtStartup} />
            </SettingRow>
          </>
        )}
      </SettingGroup>
      {enableQuickAssistant && (
        <SettingGroup theme={theme}>
          <HStack alignItems="center" justifyContent="space-between">
            <HStack alignItems="center" gap={10}>
              {t('settings.models.quick_assistant_model')}
              <Tooltip title={t('selection.settings.user_modal.model.tooltip')} arrow>
                <InfoCircleOutlined style={{ cursor: 'pointer' }} />
              </Tooltip>
              <Spacer />
            </HStack>
            <HStack alignItems="center" gap={10}>
              {!quickAssistantId ? null : (
                <HStack alignItems="center">
                  <Select
                    value={quickAssistantId || defaultAssistant.id}
                    style={{ width: 300, height: 34 }}
                    onChange={(value) => dispatch(setQuickAssistantId(value))}
                    placeholder={t('settings.models.quick_assistant_selection')}
                    showSearch
                    options={[
                      {
                        key: defaultAssistant.id,
                        value: defaultAssistant.id,
                        title: defaultAssistant.name,
                        label: (
                          <AssistantItem>
                            <ModelAvatar model={defaultAssistant.model || defaultModel} size={18} />
                            <AssistantName>{defaultAssistant.name}</AssistantName>
                            <Spacer />
                            <DefaultTag isCurrent={true}>{t('settings.models.quick_assistant_default_tag')}</DefaultTag>
                          </AssistantItem>
                        )
                      },
                      ...assistants
                        .filter((a) => a.id !== defaultAssistant.id)
                        .map((a) => ({
                          key: a.id,
                          value: a.id,
                          title: a.name,
                          label: (
                            <AssistantItem>
                              <ModelAvatar model={a.model || defaultModel} size={18} />
                              <AssistantName>{a.name}</AssistantName>
                              <Spacer />
                            </AssistantItem>
                          )
                        }))
                    ]}
                    filterOption={(input, option) => matchKeywordsInString(input, option?.title || '')}
                  />
                </HStack>
              )}
              <HStack alignItems="center" gap={0}>
                <StyledButton
                  type={quickAssistantId ? 'primary' : 'default'}
                  onClick={() => {
                    dispatch(setQuickAssistantId(defaultAssistant.id))
                  }}
                  selected={!!quickAssistantId}>
                  {t('settings.models.use_assistant')}
                </StyledButton>
                <StyledButton
                  type={!quickAssistantId ? 'primary' : 'default'}
                  onClick={() => dispatch(setQuickAssistantId(''))}
                  selected={!quickAssistantId}>
                  {t('settings.models.use_model')}
                </StyledButton>
              </HStack>
            </HStack>
          </HStack>
        </SettingGroup>
      )}
      {enableQuickAssistant && (
        <SettingGroup theme={theme}>
          <HStack alignItems="center" justifyContent="space-between">
            <SettingTitle style={{ margin: 0 }}>Commands</SettingTitle>
            <Space>
              <Button onClick={() => updateCommands(DEFAULT_QUICK_ASSISTANT_COMMANDS)}>{t('common.reset')}</Button>
              <Button type="primary" onClick={openAddCommand}>
                {t('common.add')}
              </Button>
            </Space>
          </HStack>
          <SettingDivider />

          {quickAssistantCommands.map((command) => {
            const title = command.titleKey ? t(command.titleKey) : command.title || ''
            const isCustom = command.type === 'prompt' && !command.isBuiltIn
            const iconName = command.icon?.trim() || ''
            const hasCustomIcon = !!iconName && isLucideIconName(iconName)

            return (
              <div key={command.id}>
                <SettingRow>
                  <SettingRowTitle style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {hasCustomIcon ? <DynamicIcon name={iconName as (typeof iconNames)[number]} size={16} /> : null}
                      <span>{title}</span>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--color-text-3)' }}>
                      {command.type === 'prompt' ? 'Prompt' : command.type}
                    </span>
                  </SettingRowTitle>
                  <Space>
                    <Tooltip title="Enabled">
                      <Switch
                        checked={command.enabled}
                        onChange={(enabled) =>
                          updateCommands(
                            quickAssistantCommands.map((c) => (c.id === command.id ? { ...c, enabled } : c))
                          )
                        }
                      />
                    </Tooltip>
                    <Button onClick={() => moveCommand(command.id, 'up')}>↑</Button>
                    <Button onClick={() => moveCommand(command.id, 'down')}>↓</Button>
                    <Button disabled={!isCustom} onClick={() => isCustom && openEditCommand(command)}>
                      {t('common.edit')}
                    </Button>
                    <Button
                      danger
                      disabled={!isCustom}
                      onClick={() => {
                        if (!isCustom) return
                        updateCommands(quickAssistantCommands.filter((c) => c.id !== command.id))
                      }}>
                      {t('common.delete')}
                    </Button>
                  </Space>
                </SettingRow>
                <SettingDivider />
              </div>
            )
          })}

          <Modal
            title={editingCommand ? t('common.edit') : t('common.add')}
            open={commandModalOpen}
            onOk={saveCommand}
            okButtonProps={{ disabled: !commandTitle.trim() || !commandPrompt.trim() }}
            onCancel={() => setCommandModalOpen(false)}>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <div>
                <div style={{ marginBottom: 6 }}>{t('common.name')}</div>
                <Input value={commandTitle} onChange={(e) => setCommandTitle(e.target.value)} />
              </div>
              <div>
                <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>Icon</span>
                  <a
                    href="https://lucide.dev/icons/"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '12px', color: 'var(--color-primary)' }}>
                    View all
                  </a>
                  <Button
                    size="small"
                    type="text"
                    onClick={() => {
                      const randomIcon = iconNames[Math.floor(Math.random() * iconNames.length)]
                      setCommandIcon(randomIcon)
                      setCommandIconError('')
                    }}
                    icon={<Dices size={14} />}>
                    Random
                  </Button>
                </div>
                <Space>
                  <Input
                    value={commandIcon}
                    placeholder="e.g. scan-text"
                    onChange={(e) => {
                      setCommandIcon(e.target.value)
                      if (commandIconError) setCommandIconError('')
                    }}
                    status={commandIconError ? 'error' : ''}
                  />
                  <IconPreview>
                    {commandIcon ? (
                      isLucideIconName(commandIcon.trim()) ? (
                        <DynamicIcon name={commandIcon.trim() as (typeof iconNames)[number]} size={18} />
                      ) : (
                        <OctagonX size={18} color="var(--color-error)" />
                      )
                    ) : null}
                  </IconPreview>
                </Space>
                {commandIconError && <ErrorText>{commandIconError}</ErrorText>}
              </div>
              <div>
                <div style={{ marginBottom: 6 }}>Prompt</div>
                <Input.TextArea
                  value={commandPrompt}
                  onChange={(e) => setCommandPrompt(e.target.value)}
                  autoSize={{ minRows: 3, maxRows: 8 }}
                />
                <div style={{ marginTop: 6, color: 'var(--color-text-3)', fontSize: 12 }}>
                  Placeholders: {'{selected}'}, {'{clipboard}'}, {'{selected|clipboard}'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Hide source message</span>
                <Switch checked={commandHideSource} onChange={setCommandHideSource} />
              </div>
            </Space>
          </Modal>
        </SettingGroup>
      )}
      {enableQuickAssistant && (
        <AssistantContainer>
          <HomeWindow draggable={false} />
        </AssistantContainer>
      )}
    </SettingContainer>
  )
}

const AssistantContainer = styled.div`
  width: 100%;
  height: 460px;
  background-color: var(--color-background);
  border-radius: 10px;
  border: 0.5px solid var(--color-border);
  margin: 0 auto;
  overflow: hidden;
`

const AssistantItem = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  height: 28px;
`

const AssistantName = styled.span`
  max-width: calc(100% - 60px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const IconPreview = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--color-bg-2);
  border-radius: 4px;
  border: 1px solid var(--color-border);
`

const ErrorText = styled.div`
  margin-top: 4px;
  color: var(--color-error);
  font-size: 12px;
`

const Spacer = styled.div`
  flex: 1;
`

const DefaultTag = styled.span<{ isCurrent: boolean }>`
  color: ${(props) => (props.isCurrent ? 'var(--color-primary)' : 'var(--color-text-3)')};
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
`

const StyledButton = styled(Button)<{ selected: boolean }>`
  border-radius: ${(props) => (props.selected ? '6px' : '6px')};
  z-index: ${(props) => (props.selected ? 1 : 0)};
  min-width: 80px;

  &:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right-width: 0; // No right border for the first button when not selected
  }

  &:last-child {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left-width: 1px; // Ensure left border for the last button
  }

  // Override Ant Design's default hover and focus styles for a cleaner look

  &:hover,
  &:focus {
    z-index: 1;
    border-color: ${(props) => (props.selected ? 'var(--ant-primary-color)' : 'var(--ant-primary-color-hover)')};
    box-shadow: ${(props) =>
      props.selected ? '0 0 0 2px var(--ant-primary-color-outline)' : '0 0 0 2px var(--ant-primary-color-outline)'};
  }
`

export default QuickAssistantSettings
