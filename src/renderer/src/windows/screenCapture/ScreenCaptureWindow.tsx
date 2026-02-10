import { loggerService } from '@logger'
import ImageMarkupEditor from '@renderer/components/ImageEditor/ImageMarkupEditor'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('ScreenCaptureWindow')

const ScreenCaptureWindow: FC = () => {
  const { t } = useTranslation()
  const [captureFile, setCaptureFile] = useState<FileMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    const loadCapture = async () => {
      setLoading(true)
      setErrorCode(null)

      let shouldRestoreCaptureWindow = false

      try {
        await window.api.screenCapture.hide()
        shouldRestoreCaptureWindow = true

        await new Promise((resolve) => setTimeout(resolve, 150))

        // Reuse the same screenshot flow as the attachment button so behavior stays consistent.
        const capture = await window.api.screenshot.capturePrimaryScreen()
        if (!mounted) {
          return
        }

        setCaptureFile(capture)
      } catch (error) {
        logger.error('Failed to initialize screen capture window:', error as Error)
        if (!mounted) {
          return
        }

        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('SCREEN_CAPTURE_PERMISSION_REQUIRED')) {
          setErrorCode('permission')
        } else if (message.includes('SCREEN_CAPTURE_NO_SOURCES')) {
          setErrorCode('no_sources')
        } else {
          setErrorCode('unknown')
        }
      } finally {
        if (shouldRestoreCaptureWindow) {
          try {
            await window.api.screenCapture.show()
          } catch (error) {
            logger.warn('Failed to restore screen capture window after capture:', error as Error)
          }
        }

        if (mounted) {
          setLoading(false)
        }
      }
    }

    void loadCapture()

    return () => {
      mounted = false
    }
  }, [])

  const handleCancel = useCallback(() => {
    void window.api.screenCapture.close()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      handleCancel()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handleCancel])

  const handleSave = useCallback(async (blob: Blob) => {
    const arrayBuffer = await blob.arrayBuffer()
    const fileBuffer = new Uint8Array(arrayBuffer)
    const file = (await window.api.file.savePastedImage(fileBuffer, '.png')) as FileMetadata
    await window.api.miniWindow.seedInput({ files: [file] })
    await window.api.screenCapture.close()
  }, [])

  const openScreenRecordingSettings = useCallback(async () => {
    try {
      await window.api.screenshot.openMacScreenRecordingSettings()
    } catch (error) {
      logger.warn('Failed to open screen recording settings:', error as Error)
    }
  }, [])

  if (loading) {
    return <CenterMessage>{t('common.loading')}</CenterMessage>
  }

  if (!captureFile || errorCode) {
    return (
      <CenterMessage>
        <ErrorTitle>
          {errorCode === 'permission'
            ? t('chat.input.screenshot.permission_required')
            : errorCode === 'no_sources'
              ? t('chat.input.screenshot.no_sources')
              : t('chat.input.file_error')}
        </ErrorTitle>
        <Buttons>
          {errorCode === 'permission' && (
            <ActionButton onClick={openScreenRecordingSettings}>{t('common.open')}</ActionButton>
          )}
          <ActionButton onClick={handleCancel}>{t('common.close')}</ActionButton>
        </Buttons>
      </CenterMessage>
    )
  }

  return (
    <Container>
      <ImageMarkupEditor
        src={`file://${FileManager.getSafePath(captureFile)}`}
        onCancel={handleCancel}
        onSave={handleSave}
        saveLabel={t('chat.input.screen_ask.send_to_quick_assistant')}
        cancelLabel={t('common.close')}
      />
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  height: 100%;
`

const CenterMessage = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
  text-align: center;
  padding: 0 20px;
`

const ErrorTitle = styled.div`
  max-width: 520px;
`

const Buttons = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const ActionButton = styled.button`
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  padding: 6px 10px;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.15);
  }
`

export default ScreenCaptureWindow
