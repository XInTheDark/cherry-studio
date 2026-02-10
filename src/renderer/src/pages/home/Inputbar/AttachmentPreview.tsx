import {
  FileExcelFilled,
  FileImageFilled,
  FileMarkdownFilled,
  FilePdfFilled,
  FilePptFilled,
  FileTextFilled,
  FileUnknownFilled,
  FileWordFilled,
  FileZipFilled,
  FolderOpenFilled,
  GlobalOutlined,
  LinkOutlined
} from '@ant-design/icons'
import ConfirmDialog from '@renderer/components/ConfirmDialog'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { useAttachment } from '@renderer/hooks/useAttachment'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import { Flex, Image, Tooltip } from 'antd'
import { isEmpty } from 'lodash'
import type { FC, MouseEvent } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  files: FileMetadata[]
  setFiles: (files: FileMetadata[]) => void
  onAttachmentContextMenu?: (file: FileMetadata, event: MouseEvent<HTMLDivElement>) => void
  onEditImageAttachment?: (file: FileMetadata) => void
}

const MAX_FILENAME_DISPLAY_LENGTH = 20
function truncateFileName(name: string, maxLength: number = MAX_FILENAME_DISPLAY_LENGTH) {
  if (name.length <= maxLength) return name
  return name.slice(0, maxLength - 3) + '...'
}

export const getFileIcon = (type?: string) => {
  if (!type) return <FileUnknownFilled />

  const ext = type.toLowerCase()

  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) {
    return <FileImageFilled />
  }

  if (['.doc', '.docx'].includes(ext)) {
    return <FileWordFilled />
  }
  if (['.xls', '.xlsx'].includes(ext)) {
    return <FileExcelFilled />
  }
  if (['.ppt', '.pptx'].includes(ext)) {
    return <FilePptFilled />
  }
  if (ext === '.pdf') {
    return <FilePdfFilled />
  }
  if (['.md', '.markdown'].includes(ext)) {
    return <FileMarkdownFilled />
  }

  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
    return <FileZipFilled />
  }

  if (['.txt', '.json', '.log', '.yml', '.yaml', '.xml', '.csv', '.tscn', '.gd'].includes(ext)) {
    return <FileTextFilled />
  }

  if (['.url'].includes(ext)) {
    return <LinkOutlined />
  }

  if (['.sitemap'].includes(ext)) {
    return <GlobalOutlined />
  }

  if (['.folder'].includes(ext)) {
    return <FolderOpenFilled />
  }

  return <FileUnknownFilled />
}

const isImageFile = (ext?: string) => {
  if (!ext) return false
  return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext.toLowerCase())
}

export const FileNameRender: FC<{ file: FileMetadata }> = ({ file }) => {
  const { preview } = useAttachment()
  const [visible, setVisible] = useState<boolean>(false)
  const isImage = (ext: string) => {
    return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext.toLocaleLowerCase())
  }

  const fullName = FileManager.formatFileName(file)
  const displayName = truncateFileName(fullName)

  return (
    <Tooltip
      styles={{
        body: {
          padding: 5
        }
      }}
      fresh
      title={
        <Flex vertical gap={2} align="center">
          {isImage(file.ext) && (
            <Image
              style={{ width: 80, maxHeight: 200 }}
              src={'file://' + FileManager.getSafePath(file)}
              preview={{
                visible: visible,
                src: 'file://' + FileManager.getSafePath(file),
                onVisibleChange: setVisible
              }}
            />
          )}
          <span style={{ wordBreak: 'break-all' }}>{fullName}</span>
          {formatFileSize(file.size)}
        </Flex>
      }>
      <FileName
        onClick={() => {
          if (isImage(file.ext)) {
            setVisible(true)
            return
          }
          const path = FileManager.getSafePath(file)
          const name = FileManager.formatFileName(file)
          preview(path, name, file.type, file.ext)
        }}
        title={fullName}>
        {displayName}
      </FileName>
    </Tooltip>
  )
}

const AttachmentPreview: FC<Props> = ({ files, setFiles, onAttachmentContextMenu, onEditImageAttachment }) => {
  const { t } = useTranslation()
  const [contextMenu, setContextMenu] = useState<{
    file: FileMetadata
    x: number
    y: number
  } | null>(null)
  const [imageEditMenu, setImageEditMenu] = useState<{
    file: FileMetadata
    x: number
    y: number
  } | null>(null)

  const handleContextMenu = async (file: FileMetadata, event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()

    const x = rect.left
    const y = rect.bottom

    if (isImageFile(file.ext) && onEditImageAttachment) {
      setImageEditMenu({ file, x, y })
      setContextMenu(null)
      return
    }

    try {
      const isText = await window.api.file.isTextFile(file.path)
      if (!isText) {
        setContextMenu(null)
        return
      }

      setContextMenu({
        file,
        x: rect.left + rect.width / 2,
        y: rect.top
      })
    } catch (error) {
      setContextMenu(null)
    }
  }

  useEffect(() => {
    if (!imageEditMenu) {
      return
    }

    const handleGlobalClick = () => {
      setImageEditMenu(null)
    }

    window.addEventListener('mousedown', handleGlobalClick)
    return () => {
      window.removeEventListener('mousedown', handleGlobalClick)
    }
  }, [imageEditMenu])

  const handleImageEdit = () => {
    if (imageEditMenu && onEditImageAttachment) {
      onEditImageAttachment(imageEditMenu.file)
    }
    setImageEditMenu(null)
  }

  const handleConfirm = () => {
    if (contextMenu && onAttachmentContextMenu) {
      // Create a synthetic mouse event for the callback
      const syntheticEvent = {
        preventDefault: () => {},
        stopPropagation: () => {}
      } as MouseEvent<HTMLDivElement>
      onAttachmentContextMenu(contextMenu.file, syntheticEvent)
    }
    setContextMenu(null)
  }

  const handleCancel = () => {
    setContextMenu(null)
    setImageEditMenu(null)
  }

  if (isEmpty(files)) {
    return null
  }

  return (
    <>
      <ContentContainer>
        {files.map((file) => (
          <CustomTag
            key={file.id}
            icon={getFileIcon(file.ext)}
            color="#37a5aa"
            closable
            onClose={() => setFiles(files.filter((f) => f.id !== file.id))}
            onContextMenu={(event) => {
              void handleContextMenu(file, event)
            }}>
            <FileNameRender file={file} />
          </CustomTag>
        ))}
      </ContentContainer>

      {imageEditMenu && (
        <ImageMenu
          style={{ left: imageEditMenu.x, top: imageEditMenu.y }}
          onClick={(event) => {
            event.stopPropagation()
          }}>
          <ImageMenuButton onClick={handleImageEdit}>{t('chat.input.edit_image')}</ImageMenuButton>
        </ImageMenu>
      )}

      {contextMenu && (
        <ConfirmDialog
          x={contextMenu.x}
          y={contextMenu.y}
          message={t('chat.input.paste_text_file_confirm')}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </>
  )
}

const ContentContainer = styled.div`
  width: 100%;
  padding: 5px 15px 5px 15px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 4px;
`

const FileName = styled.span`
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
`

export default AttachmentPreview

const ImageMenu = styled.div`
  position: fixed;
  z-index: 1200;
  background: var(--color-background-mute);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.2);
  padding: 4px;
`

const ImageMenuButton = styled.button`
  border: 0;
  width: 100%;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  font-size: 12px;
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;

  &:hover {
    background: var(--color-background-soft);
  }
`
