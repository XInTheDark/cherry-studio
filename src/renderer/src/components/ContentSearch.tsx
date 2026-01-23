import { ActionIconButton } from '@renderer/components/Buttons'
import NarrowLayout from '@renderer/pages/home/Messages/NarrowLayout'
import { scrollIntoView } from '@renderer/utils'
import { Tooltip } from 'antd'
import { debounce } from 'lodash'
import { CaseSensitive, ChevronDown, ChevronUp, User, WholeWord, X } from 'lucide-react'
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  children?: React.ReactNode
  searchTarget: React.RefObject<React.ReactNode> | React.RefObject<HTMLElement> | HTMLElement
  /**
   * 过滤`node`，`node`只会是`Node.TEXT_NODE`类型的文本节点
   *
   * 返回`true`表示该`node`会被搜索
   */
  filter: NodeFilter
  includeUser?: boolean
  onIncludeUserChange?: (value: boolean) => void
  /**
   * 是否显示“包含用户问题”切换按钮（默认为 true）。
   * 在富文本编辑器场景通常不需要该按钮。
   */
  showUserToggle?: boolean
  /**
   * 搜索条定位方式
   */
  positionMode?: 'fixed' | 'absolute' | 'sticky'
  /**
   * Fired when the search UI becomes active/inactive.
   * Used by chat to temporarily expand rendered messages so DOM-based search can find all matches.
   */
  onActiveChange?: (active: boolean) => void
}

enum SearchCompletedState {
  NotSearched,
  Searched
}

export interface ContentSearchRef {
  disable(): void
  enable(initialText?: string): void
  // 搜索下一个并定位
  searchNext(): void
  // 搜索上一个并定位
  searchPrev(): void
  // 搜索并定位
  search(): void
  // 搜索但不定位，或者说是更新
  silentSearch(): void
  focus(): void
}

const escapeRegExp = (string: string): string => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // $& means the whole matched string
}

const getRangePrimaryRect = (range: Range): DOMRect | null => {
  // Prefer client rects: they reflect the actual visual order in layouts where DOM order differs
  // (e.g. column-reverse chat + incremental rendering).
  const rects = Array.from(range.getClientRects())
  const primary = rects.find((rect) => rect.width > 0 && rect.height > 0)
  if (primary) return primary

  const fallback = range.getBoundingClientRect()
  if (fallback.width > 0 && fallback.height > 0) return fallback

  return null
}

const sortRangesByVisualOrder = (ranges: Range[]): Range[] => {
  return ranges
    .map((range, index) => ({ range, index }))
    .sort((a, b) => {
      const rectA = getRangePrimaryRect(a.range)
      const rectB = getRangePrimaryRect(b.range)

      // Push "non-rendered" ranges to the end to avoid polluting navigation order.
      if (!rectA && !rectB) return a.index - b.index
      if (!rectA) return 1
      if (!rectB) return -1

      if (rectA.top !== rectB.top) return rectA.top - rectB.top
      if (rectA.left !== rectB.left) return rectA.left - rectB.left

      return a.index - b.index
    })
    .map(({ range }) => range)
}

const findClosestRangeIndex = (ranges: Range[], anchor: { top: number; left: number } | null): number | null => {
  if (!anchor) return null
  if (ranges.length === 0) return null

  let bestIndex = 0
  let bestScore = Number.POSITIVE_INFINITY

  for (let i = 0; i < ranges.length; i += 1) {
    const rect = getRangePrimaryRect(ranges[i])
    if (!rect) continue

    // Manhattan distance is sufficient here and avoids sqrt.
    const score = Math.abs(rect.top - anchor.top) + Math.abs(rect.left - anchor.left)
    if (score < bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  return Number.isFinite(bestScore) ? bestIndex : null
}

const findRangesInTarget = (
  target: HTMLElement,
  filter: NodeFilter,
  searchText: string,
  isCaseSensitive: boolean,
  isWholeWord: boolean
): Range[] => {
  CSS.highlights.clear()
  const ranges: Range[] = []

  const escapedSearchText = escapeRegExp(searchText)

  // 检查搜索文本是否仅包含拉丁字母
  const hasOnlyLatinLetters = /^[a-zA-Z\s]+$/.test(searchText)

  // 只有当搜索文本仅包含拉丁字母时才应用大小写敏感
  const regexFlags = hasOnlyLatinLetters && isCaseSensitive ? 'g' : 'gi'
  const regexPattern = isWholeWord ? `\\b${escapedSearchText}\\b` : escapedSearchText
  const searchRegex = new RegExp(regexPattern, regexFlags)
  const treeWalker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, filter)
  const allTextNodes: { node: Node; startOffset: number }[] = []
  let fullText = ''

  // 1. 拼接所有文本节点内容
  while (treeWalker.nextNode()) {
    allTextNodes.push({
      node: treeWalker.currentNode,
      startOffset: fullText.length
    })
    fullText += treeWalker.currentNode.nodeValue
  }

  // 2.在完整文本中查找匹配项
  let match: RegExpExecArray | null = null
  while ((match = searchRegex.exec(fullText))) {
    const matchStart = match.index
    const matchEnd = matchStart + match[0].length

    // 3. 将匹配项的索引映射回DOM Range
    let startNode: Node | null = null
    let endNode: Node | null = null
    let startOffset = 0
    let endOffset = 0

    // 找到起始节点和偏移
    for (const nodeInfo of allTextNodes) {
      if (
        matchStart >= nodeInfo.startOffset &&
        matchStart < nodeInfo.startOffset + (nodeInfo.node.nodeValue?.length ?? 0)
      ) {
        startNode = nodeInfo.node
        startOffset = matchStart - nodeInfo.startOffset
        break
      }
    }

    // 找到结束节点和偏移
    for (const nodeInfo of allTextNodes) {
      if (
        matchEnd > nodeInfo.startOffset &&
        matchEnd <= nodeInfo.startOffset + (nodeInfo.node.nodeValue?.length ?? 0)
      ) {
        endNode = nodeInfo.node
        endOffset = matchEnd - nodeInfo.startOffset
        break
      }
    }

    // 如果起始和结束节点都找到了，则创建一个 Range
    if (startNode && endNode) {
      const range = new Range()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      ranges.push(range)
    }
  }

  return ranges
}

// eslint-disable-next-line @eslint-react/no-forward-ref
export const ContentSearch = React.forwardRef<ContentSearchRef, Props>(
  (
    {
      searchTarget,
      filter,
      includeUser = false,
      onIncludeUserChange,
      showUserToggle = true,
      positionMode = 'fixed',
      onActiveChange
    },
    ref
  ) => {
    const target: HTMLElement | null = (() => {
      if (searchTarget instanceof HTMLElement) {
        return searchTarget
      } else {
        return (searchTarget.current as HTMLElement) ?? null
      }
    })()
    const containerRef = React.useRef<HTMLDivElement>(null)
    const searchInputRef = React.useRef<HTMLInputElement>(null)
    const [enableContentSearch, setEnableContentSearch] = useState(false)
    const [searchCompleted, setSearchCompleted] = useState(SearchCompletedState.NotSearched)
    const [isCaseSensitive, setIsCaseSensitive] = useState(false)
    const [isWholeWord, setIsWholeWord] = useState(false)
    const [allRanges, setAllRanges] = useState<Range[]>([])
    const [currentIndex, setCurrentIndex] = useState(-1)
    const prevSearchText = useRef('')
    const lastLocatedAnchorRef = useRef<{ top: number; left: number } | null>(null)
    const { t } = useTranslation()

    const resetSearch = useCallback(() => {
      CSS.highlights.clear()
      setAllRanges([])
      setSearchCompleted(SearchCompletedState.NotSearched)
      setCurrentIndex(-1)
      lastLocatedAnchorRef.current = null
    }, [])

    const locateByIndexInternal = useCallback((ranges: Range[], index: number, shouldScroll = true) => {
      // 清理旧的高亮
      CSS.highlights.clear()

      if (ranges.length > 0) {
        // 1. 创建并注册所有匹配项的高亮
        const allMatchesHighlight = new Highlight(...ranges)
        CSS.highlights.set('search-matches', allMatchesHighlight)

        // 2. 如果有当前项，为其创建并注册一个特殊的高亮
        if (index !== -1 && ranges[index]) {
          const currentMatchRange = ranges[index]
          const currentMatchHighlight = new Highlight(currentMatchRange)
          CSS.highlights.set('current-match', currentMatchHighlight)

          // 3. 将当前项滚动到视图中
          // 获取第一个文本节点的父元素来进行滚动
          const parentElement = currentMatchRange.startContainer.parentElement
          if (shouldScroll && parentElement) {
            // IMPORTANT: Chat message list uses an inverted scroll layout (column-reverse + scrollTop=0 "bottom"),
            // so manual scrollTop math is unreliable. Native scrollIntoView handles this correctly, and Chromium's
            // `container: 'nearest'` keeps the scroll within the chat pane.
            scrollIntoView(parentElement, {
              behavior: 'smooth',
              block: 'center',
              inline: 'nearest',
              container: 'nearest'
            })
          }

          const rect = getRangePrimaryRect(currentMatchRange)
          lastLocatedAnchorRef.current = rect ? { top: rect.top, left: rect.left } : null
        }
      }
    }, [])

    const locateByIndex = useCallback(
      (shouldScroll = true) => {
        locateByIndexInternal(allRanges, currentIndex, shouldScroll)
      },
      [allRanges, currentIndex, locateByIndexInternal]
    )

    const performSearch = useCallback(
      ({
        jump = false,
        preserveSelection = false,
        shouldScroll = false
      }: {
        jump?: boolean
        preserveSelection?: boolean
        shouldScroll?: boolean
      } = {}) => {
        const searchText = searchInputRef.current?.value.trim() ?? null
        setSearchCompleted(SearchCompletedState.Searched)

        if (!target || searchText === null || searchText === '') {
          resetSearch()
          return
        }

        const ranges = sortRangesByVisualOrder(
          findRangesInTarget(target, filter, searchText, isCaseSensitive, isWholeWord)
        )

        let nextIndex = -1

        if (ranges.length > 0) {
          if (jump) {
            nextIndex = 0
          } else if (preserveSelection && currentIndex !== -1) {
            // Keep the current selection stable when new messages are loaded or the DOM reflows.
            // This avoids the "jumps around" feeling while the chat incrementally renders.
            const closestIndex = findClosestRangeIndex(ranges, lastLocatedAnchorRef.current)
            nextIndex = closestIndex ?? Math.min(currentIndex, ranges.length - 1)
          } else {
            nextIndex = -1
          }
        } else {
          nextIndex = -1
        }

        setAllRanges(ranges)
        setCurrentIndex(nextIndex)
        locateByIndexInternal(ranges, nextIndex, shouldScroll)
      },
      [currentIndex, filter, isCaseSensitive, isWholeWord, locateByIndexInternal, resetSearch, target]
    )

    const implementation = useMemo(
      () => ({
        disable: () => {
          if (!enableContentSearch) {
            CSS.highlights.clear()
            return
          }
          setEnableContentSearch(false)
          CSS.highlights.clear()
          onActiveChange?.(false)
        },
        enable: (initialText?: string) => {
          setEnableContentSearch(true)
          onActiveChange?.(true)
          if (searchInputRef.current) {
            const inputEl = searchInputRef.current
            if (initialText && initialText.trim().length > 0) {
              inputEl.value = initialText
              requestAnimationFrame(() => {
                inputEl.focus()
                inputEl.select()
                // Initial open should not auto-select a match (0/x is confusing) and should
                // not inherit a previous selection from an earlier search session.
                performSearch({ jump: false, preserveSelection: false, shouldScroll: false })
              })
            } else {
              requestAnimationFrame(() => {
                inputEl.focus()
                inputEl.select()
              })
            }
          }
        },
        searchNext: () => {
          if (!enableContentSearch) return
          if (allRanges.length > 0) {
            setCurrentIndex((prev) => (prev < allRanges.length - 1 ? prev + 1 : 0))
          }
        },
        searchPrev: () => {
          if (!enableContentSearch) return
          if (allRanges.length > 0) {
            setCurrentIndex((prev) => (prev > 0 ? prev - 1 : allRanges.length - 1))
          }
        },
        resetSearchState: () => {
          setSearchCompleted(SearchCompletedState.NotSearched)
        },
        search: () => {
          if (!enableContentSearch) return
          performSearch({ jump: true, preserveSelection: false, shouldScroll: true })
        },
        silentSearch: () => {
          if (!enableContentSearch) return
          performSearch({ jump: false, preserveSelection: true, shouldScroll: false })
        },
        focus: () => {
          if (!enableContentSearch) return
          searchInputRef.current?.focus()
        }
      }),
      [allRanges.length, enableContentSearch, onActiveChange, performSearch]
    )

    // While typing, update the match list/count without auto-jumping. Jumping is driven by Enter / next/prev.
    const _searchHandlerDebounce = useMemo(
      () =>
        debounce(() => {
          // Compute ranges but keep currentIndex at -1 so the UI shows 0/N until user navigates.
          performSearch({ jump: false, preserveSelection: false, shouldScroll: false })
        }, 250),
      [performSearch]
    )

    const searchHandler = useCallback(() => {
      _searchHandlerDebounce()
    }, [_searchHandlerDebounce])

    const userInputHandler = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value.trim()
        if (value.length === 0) {
          resetSearch()
        } else {
          searchHandler()
        }
        prevSearchText.current = value
      },
      [searchHandler, resetSearch]
    )

    const keyDownHandler = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          const value = (event.target as HTMLInputElement).value.trim()
          if (value.length === 0) {
            resetSearch()
            return
          }
          // If we don't have a selected match yet, Enter should jump to the first match (oldest),
          // even if the debounced search hasn't fired yet.
          if (allRanges.length === 0 || currentIndex === -1) {
            implementation.search()
            return
          }

          if (event.shiftKey) implementation.searchPrev()
          else implementation.searchNext()
        } else if (event.key === 'Escape') {
          event.stopPropagation()
          implementation.disable()
        }
      },
      [allRanges.length, currentIndex, implementation, resetSearch]
    )

    const searchInputFocus = useCallback(() => {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }, [])

    const userOutlinedButtonOnClick = useCallback(() => {
      onIncludeUserChange?.(!includeUser)
      searchInputFocus()
    }, [includeUser, onIncludeUserChange, searchInputFocus])

    useImperativeHandle(ref, () => implementation, [implementation])

    useEffect(() => {
      locateByIndex()
    }, [currentIndex, locateByIndex])

    useEffect(() => {
      if (enableContentSearch && searchInputRef.current?.value.trim()) {
        // Re-run search without forcing a selection. This is usually triggered by toggles.
        // Preserve current selection when possible, but never auto-scroll.
        performSearch({ jump: false, preserveSelection: true, shouldScroll: false })
      }
    }, [isCaseSensitive, isWholeWord, enableContentSearch, performSearch])

    const prevButtonOnClick = () => {
      implementation.searchPrev()
      searchInputFocus()
    }

    const nextButtonOnClick = () => {
      implementation.searchNext()
      searchInputFocus()
    }

    const closeButtonOnClick = () => {
      implementation.disable()
    }

    const caseSensitiveButtonOnClick = () => {
      setIsCaseSensitive(!isCaseSensitive)
      searchInputFocus()
    }

    const wholeWordButtonOnClick = () => {
      setIsWholeWord(!isWholeWord)
      searchInputFocus()
    }

    return (
      <Container
        ref={containerRef}
        style={enableContentSearch ? {} : { display: 'none' }}
        $overlayPosition={positionMode === 'absolute' ? 'absolute' : 'static'}>
        <NarrowLayout style={{ width: '100%' }}>
          <SearchBarContainer $position={positionMode}>
            <InputWrapper>
              <Input
                ref={searchInputRef}
                onInput={userInputHandler}
                onKeyDown={keyDownHandler}
                placeholder={t('chat.assistant.search.placeholder')}
                style={{ lineHeight: '20px' }}
              />
              <ToolBar>
                {showUserToggle && (
                  <Tooltip title={t('button.includes_user_questions')} mouseEnterDelay={0.8} placement="bottom">
                    <ActionIconButton onClick={userOutlinedButtonOnClick}>
                      <User size={18} style={{ color: includeUser ? 'var(--color-link)' : 'var(--color-icon)' }} />
                    </ActionIconButton>
                  </Tooltip>
                )}
                <Tooltip title={t('button.case_sensitive')} mouseEnterDelay={0.8} placement="bottom">
                  <ActionIconButton onClick={caseSensitiveButtonOnClick}>
                    <CaseSensitive
                      size={18}
                      style={{ color: isCaseSensitive ? 'var(--color-link)' : 'var(--color-icon)' }}
                    />
                  </ActionIconButton>
                </Tooltip>
                <Tooltip title={t('button.whole_word')} mouseEnterDelay={0.8} placement="bottom">
                  <ActionIconButton onClick={wholeWordButtonOnClick}>
                    <WholeWord size={18} style={{ color: isWholeWord ? 'var(--color-link)' : 'var(--color-icon)' }} />
                  </ActionIconButton>
                </Tooltip>
              </ToolBar>
            </InputWrapper>
            <Separator></Separator>
            <SearchResults>
              {searchCompleted !== SearchCompletedState.NotSearched && allRanges.length > 0 ? (
                <>
                  <SearchResultCount>{currentIndex + 1}</SearchResultCount>
                  <SearchResultSeparator>/</SearchResultSeparator>
                  <SearchResultTotalCount>{allRanges.length}</SearchResultTotalCount>
                </>
              ) : (
                <SearchResultsPlaceholder>0/0</SearchResultsPlaceholder>
              )}
            </SearchResults>
            <ToolBar>
              <ActionIconButton onClick={prevButtonOnClick} disabled={allRanges.length === 0}>
                <ChevronUp size={18} />
              </ActionIconButton>
              <ActionIconButton onClick={nextButtonOnClick} disabled={allRanges.length === 0}>
                <ChevronDown size={18} />
              </ActionIconButton>
              <ActionIconButton onClick={closeButtonOnClick}>
                <X size={18} />
              </ActionIconButton>
            </ToolBar>
          </SearchBarContainer>
        </NarrowLayout>
        <Placeholder />
      </Container>
    )
  }
)

ContentSearch.displayName = 'ContentSearch'

const Container = styled.div<{ $overlayPosition: 'static' | 'absolute' }>`
  display: flex;
  flex-direction: row;
  position: ${({ $overlayPosition }) => $overlayPosition};
  top: ${({ $overlayPosition }) => ($overlayPosition === 'absolute' ? '0' : 'auto')};
  left: ${({ $overlayPosition }) => ($overlayPosition === 'absolute' ? '0' : 'auto')};
  right: ${({ $overlayPosition }) => ($overlayPosition === 'absolute' ? '0' : 'auto')};
  z-index: 999;
`

const SearchBarContainer = styled.div<{ $position: 'fixed' | 'absolute' | 'sticky' }>`
  border: 1px solid var(--color-primary);
  border-radius: 10px;
  transition: all 0.2s ease;
  position: ${({ $position }) => $position};
  top: 15px;
  left: 20px;
  right: 20px;
  margin-bottom: 5px;
  padding: 5px 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-background);
  flex: 1 1 auto; /* Take up input's previous space */
`

const Placeholder = styled.div`
  width: 5px;
`

const InputWrapper = styled.div`
  display: flex;
  align-items: center;
  flex: 1 1 auto; /* Take up input's previous space */
`

const Input = styled.input`
  border: none;
  color: var(--color-text);
  background-color: transparent;
  outline: none;
  width: 100%;
  padding: 0 5px; /* Adjust padding, wrapper will handle spacing */
  flex: 1; /* Allow input to grow */
  font-size: 14px;
  font-family: Ubuntu;
`

const ToolBar = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: tpx;
`

const Separator = styled.div`
  width: 1px;
  height: 1.5em;
  background-color: var(--color-border);
  margin-left: 2px;
  margin-right: 2px;
  flex: 0 0 auto;
`

const SearchResults = styled.div`
  display: flex;
  justify-content: center;
  width: 80px;
  margin: 0 2px;
  flex: 0 0 auto;
  color: var(--color-text-1);
  font-size: 14px;
  font-family: Ubuntu;
`

const SearchResultsPlaceholder = styled.span`
  color: var(--color-text-1);
  opacity: 0.5;
`

const SearchResultCount = styled.span`
  color: var(--color-text);
`

const SearchResultSeparator = styled.span`
  color: var(--color-text);
  margin: 0 4px;
`

const SearchResultTotalCount = styled.span`
  color: var(--color-text);
`
