import { loggerService } from '@logger'
import ImageMarkupEditor from '@renderer/components/ImageEditor/ImageMarkupEditor'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import { Modal } from 'antd'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('ImageAttachmentEditorModal')

interface ImageAttachmentEditorModalProps {
  file: FileMetadata
  open: boolean
  onCancel: () => void
  onSaved: (file: FileMetadata) => void
}

const ImageAttachmentEditorModal: FC<ImageAttachmentEditorModalProps> = ({ file, open, onCancel, onSaved }) => {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)

  const handleSave = async (blob: Blob) => {
    if (saving) return

    setSaving(true)
    try {
      const arrayBuffer = await blob.arrayBuffer()
      const fileBuffer = new Uint8Array(arrayBuffer)
      const edited = await window.api.file.savePastedImage(fileBuffer, '.png')
      onSaved(edited)
    } catch (error) {
      logger.error('Failed to save edited attachment image:', error as Error)
      window.toast.error(t('chat.input.file_error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      footer={null}
      width="92vw"
      style={{ top: 16 }}
      styles={{
        content: {
          height: '88vh',
          padding: 0,
          overflow: 'hidden'
        },
        body: {
          height: '100%'
        }
      }}
      destroyOnHidden>
      <ImageMarkupEditor
        src={`file://${FileManager.getSafePath(file)}`}
        onCancel={onCancel}
        onSave={handleSave}
        saveLabel={saving ? t('common.loading') : t('common.save')}
      />
    </Modal>
  )
}

export default ImageAttachmentEditorModal
