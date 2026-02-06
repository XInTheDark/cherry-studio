import { ActionIconButton } from '@renderer/components/Buttons'
import EditIcon from '@renderer/components/Icons/EditIcon'
import {
  MdiLightbulbAutoOutline,
  MdiLightbulbOffOutline,
  MdiLightbulbOn,
  MdiLightbulbOn30,
  MdiLightbulbOn50,
  MdiLightbulbOn80,
  MdiLightbulbOn90,
  MdiLightbulbQuestion
} from '@renderer/components/Icons/SVGIcon'
import { QuickPanelReservedSymbol, useQuickPanel } from '@renderer/components/QuickPanel'
import {
  coerceReasoningEffortOptionForModel,
  getThinkModelType,
  isDoubaoThinkingAutoModel,
  isFixedReasoningModel,
  isGPT5SeriesReasoningModel,
  isOpenAIModel,
  isOpenAIWebSearchModel,
  MODEL_SUPPORTED_OPTIONS
} from '@renderer/config/models'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { Model, ThinkingOption } from '@renderer/types'
import { Input, Modal, Tooltip } from 'antd'
import type { FC, ReactElement } from 'react'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  quickPanel: ToolQuickPanelApi
  model: Model
  assistantId: string
}

const OPENAI_REASONING_PRESET_OPTIONS = ['none', 'low', 'medium', 'high', 'xhigh'] as const satisfies ThinkingOption[]

const VALID_CUSTOM_REASONING_EFFORT_OPTIONS = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'auto'
] as const satisfies ThinkingOption[]

const ThinkingButton: FC<Props> = ({ quickPanel, model, assistantId }): ReactElement => {
  const { t } = useTranslation()
  const quickPanelHook = useQuickPanel()
  const { assistant, updateAssistantSettings } = useAssistant(assistantId)

  const isOpenAIThinkingModel = useMemo(() => isOpenAIModel(model), [model])

  // For OpenAI models, we treat reasoning_effort_cache as the "user preference",
  // while reasoning_effort may be coerced to a model-supported effective value.
  const currentReasoningEffort = useMemo<ThinkingOption>(() => {
    if (isOpenAIThinkingModel) {
      return (assistant.settings?.reasoning_effort_cache ??
        assistant.settings?.reasoning_effort ??
        'none') as ThinkingOption
    }
    return (assistant.settings?.reasoning_effort ?? 'none') as ThinkingOption
  }, [assistant.settings?.reasoning_effort, assistant.settings?.reasoning_effort_cache, isOpenAIThinkingModel])

  // 确定当前模型支持的选项类型
  const modelType = useMemo(() => getThinkModelType(model), [model])

  const isFixedReasoning = isFixedReasoningModel(model)

  // 获取当前模型支持的选项
  const supportedOptions: ThinkingOption[] = useMemo(() => {
    if (isOpenAIThinkingModel) {
      // Simplified: always show the same preset options for OpenAI models.
      return [...OPENAI_REASONING_PRESET_OPTIONS]
    }
    if (modelType === 'doubao') {
      if (isDoubaoThinkingAutoModel(model)) {
        return ['none', 'auto', 'high']
      }
      return ['none', 'high']
    }
    return MODEL_SUPPORTED_OPTIONS[modelType]
  }, [isOpenAIThinkingModel, model, modelType])

  const onThinkingChange = useCallback(
    (option?: ThinkingOption) => {
      if (isOpenAIThinkingModel) {
        const preference = option
        const effective = coerceReasoningEffortOptionForModel(preference, model, {
          enableWebSearch: Boolean(assistant.enableWebSearch)
        })

        if (
          preference === 'minimal' &&
          isOpenAIWebSearchModel(model) &&
          isGPT5SeriesReasoningModel(model) &&
          assistant.enableWebSearch
        ) {
          // Minimal reasoning cannot be used with built-in web search on GPT-5 series.
          window.toast.warning(t('chat.web_search.warning.openai'))
        }

        const isEnabled = effective !== undefined && effective !== 'none'
        updateAssistantSettings({
          reasoning_effort: effective,
          reasoning_effort_cache: preference,
          qwenThinkMode: isEnabled ? true : false
        })
        return
      }

      const isEnabled = option !== undefined && option !== 'none'

      updateAssistantSettings({
        reasoning_effort: option,
        reasoning_effort_cache: option,
        qwenThinkMode: isEnabled ? true : false
      })
    },
    [assistant.enableWebSearch, isOpenAIThinkingModel, model, t, updateAssistantSettings]
  )

  const openCustomReasoningEffortModal = useCallback(() => {
    const title = `${t('assistants.settings.reasoning_effort.label')} - ${t('memory.custom')}`
    let inputValue = String(currentReasoningEffort)

    const normalizeInput = (value: string): ThinkingOption | undefined => {
      const v = value.trim().toLowerCase()
      if (!v) return undefined
      if (v === 'off') return 'none'
      if ((VALID_CUSTOM_REASONING_EFFORT_OPTIONS as readonly string[]).includes(v)) {
        return v as ThinkingOption
      }
      return undefined
    }

    Modal.confirm({
      title,
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      content: (
        <div style={{ marginTop: 8 }}>
          <Input
            defaultValue={String(currentReasoningEffort)}
            placeholder="default | none | minimal | low | medium | high | xhigh | auto"
            onChange={(e) => {
              inputValue = e.target.value
            }}
          />
          <div style={{ marginTop: 8, opacity: 0.8, fontSize: 12 }}>
            {t('memory.custom')}: default/none/minimal/low/medium/high/xhigh/auto
          </div>
        </div>
      ),
      onOk: async () => {
        const normalized = normalizeInput(inputValue)
        if (!normalized) {
          window.toast.error('Invalid reasoning effort value.')
          // Reject promise to keep modal open.
          throw new Error('Invalid reasoning effort value')
        }
        onThinkingChange(normalized)
      }
    })
  }, [currentReasoningEffort, onThinkingChange, t])

  const isOpenAICustomSelected = useMemo(() => {
    if (!isOpenAIThinkingModel) return false
    return !(OPENAI_REASONING_PRESET_OPTIONS as readonly ThinkingOption[]).includes(currentReasoningEffort)
  }, [currentReasoningEffort, isOpenAIThinkingModel])

  const openAICustomLabel = useMemo(() => {
    if (!isOpenAIThinkingModel) return ''
    return isOpenAICustomSelected ? `${t('memory.custom')}: ${currentReasoningEffort}` : t('memory.custom')
  }, [currentReasoningEffort, isOpenAICustomSelected, isOpenAIThinkingModel, t])

  const openAICustomDescription = useMemo(() => {
    if (!isOpenAIThinkingModel) return ''
    return 'Set an internal reasoning effort value.'
  }, [isOpenAIThinkingModel])

  const openAICustomItem = useMemo(() => {
    if (!isOpenAIThinkingModel) return undefined
    return {
      label: openAICustomLabel,
      description: openAICustomDescription,
      icon: <EditIcon size="1rem" />,
      isSelected: isOpenAICustomSelected,
      action: () => openCustomReasoningEffortModal()
    }
  }, [
    isOpenAICustomSelected,
    isOpenAIThinkingModel,
    openAICustomDescription,
    openAICustomLabel,
    openCustomReasoningEffortModal
  ])

  const isActive = useMemo(() => {
    // Keep existing behavior: treat any non-'none' option as active.
    // (Note: for OpenAI models, the cache/preference might differ from effective.)
    return currentReasoningEffort !== 'none'
  }, [currentReasoningEffort])

  const isPressed = useMemo(() => currentReasoningEffort !== 'none', [currentReasoningEffort])

  const iconOption = useMemo(() => {
    // For OpenAI models, show an icon that matches the preference (cache).
    return currentReasoningEffort
  }, [currentReasoningEffort])

  const reasoningEffortOptionLabelMap = {
    default: t('assistants.settings.reasoning_effort.default'),
    none: t('assistants.settings.reasoning_effort.off'),
    minimal: t('assistants.settings.reasoning_effort.minimal'),
    high: t('assistants.settings.reasoning_effort.high'),
    low: t('assistants.settings.reasoning_effort.low'),
    medium: t('assistants.settings.reasoning_effort.medium'),
    auto: t('assistants.settings.reasoning_effort.auto'),
    xhigh: t('assistants.settings.reasoning_effort.xhigh')
  } as const satisfies Record<ThinkingOption, string>

  const reasoningEffortDescriptionMap = {
    default: t('assistants.settings.reasoning_effort.default_description'),
    none: t('assistants.settings.reasoning_effort.off_description'),
    minimal: t('assistants.settings.reasoning_effort.minimal_description'),
    low: t('assistants.settings.reasoning_effort.low_description'),
    medium: t('assistants.settings.reasoning_effort.medium_description'),
    high: t('assistants.settings.reasoning_effort.high_description'),
    xhigh: t('assistants.settings.reasoning_effort.xhigh_description'),
    auto: t('assistants.settings.reasoning_effort.auto_description')
  } as const satisfies Record<ThinkingOption, string>

  const panelItems = useMemo(() => {
    // 使用表中定义的选项创建UI选项
    const items = supportedOptions.map((option) => ({
      label: reasoningEffortOptionLabelMap[option],
      description: reasoningEffortDescriptionMap[option],
      icon: ThinkingIcon({ option }),
      isSelected: currentReasoningEffort === option,
      action: () => onThinkingChange(option)
    }))

    if (openAICustomItem) {
      items.push(openAICustomItem)
    }

    return items
  }, [
    supportedOptions,
    reasoningEffortOptionLabelMap,
    reasoningEffortDescriptionMap,
    currentReasoningEffort,
    onThinkingChange,
    openAICustomItem
  ])

  const openQuickPanel = useCallback(() => {
    quickPanelHook.open({
      title: t('assistants.settings.reasoning_effort.label'),
      list: panelItems,
      symbol: QuickPanelReservedSymbol.Thinking
    })
  }, [quickPanelHook, panelItems, t])

  const handleOpenQuickPanel = useCallback(() => {
    if (isFixedReasoning) return

    if (quickPanelHook.isVisible && quickPanelHook.symbol === QuickPanelReservedSymbol.Thinking) {
      quickPanelHook.close()
      return
    }

    openQuickPanel()
  }, [openQuickPanel, quickPanelHook, isFixedReasoning])

  useEffect(() => {
    if (isFixedReasoning) return

    const disposeMenu = quickPanel.registerRootMenu([
      {
        label: t('assistants.settings.reasoning_effort.label'),
        description: '',
        icon: ThinkingIcon({ option: currentReasoningEffort }),
        isMenu: true,
        action: () => openQuickPanel()
      }
    ])

    const disposeTrigger = quickPanel.registerTrigger(QuickPanelReservedSymbol.Thinking, () => openQuickPanel())

    return () => {
      disposeMenu()
      disposeTrigger()
    }
  }, [currentReasoningEffort, openQuickPanel, quickPanel, t, isFixedReasoning])

  const ariaLabel = isFixedReasoning ? t('chat.input.thinking.label') : t('assistants.settings.reasoning_effort.label')

  return (
    <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow>
      <ActionIconButton
        onClick={handleOpenQuickPanel}
        active={isFixedReasoning || isActive}
        aria-label={ariaLabel}
        aria-pressed={isPressed}
        style={isFixedReasoning ? { cursor: 'default' } : undefined}>
        {ThinkingIcon({ option: iconOption, isFixedReasoning })}
      </ActionIconButton>
    </Tooltip>
  )
}

const ThinkingIcon = (props: { option?: ThinkingOption; isFixedReasoning?: boolean }) => {
  let IconComponent: React.FC<React.SVGProps<SVGSVGElement>> | null = null
  if (props.isFixedReasoning) {
    IconComponent = MdiLightbulbAutoOutline
  } else {
    switch (props.option) {
      case 'minimal':
        IconComponent = MdiLightbulbOn30
        break
      case 'low':
        IconComponent = MdiLightbulbOn50
        break
      case 'medium':
        IconComponent = MdiLightbulbOn80
        break
      case 'high':
        IconComponent = MdiLightbulbOn90
        break
      case 'xhigh':
        IconComponent = MdiLightbulbOn
        break
      case 'auto':
        IconComponent = MdiLightbulbAutoOutline
        break
      case 'none':
        IconComponent = MdiLightbulbOffOutline
        break
      case 'default':
      default:
        IconComponent = MdiLightbulbQuestion
        break
    }
  }

  return <IconComponent className="icon" width={18} height={18} style={{ marginTop: -2 }} />
}

export default ThinkingButton
