'use client';

import { useRef, useEffect } from 'react';
import { getAccomplish } from '../../lib/accomplish';
import { analytics } from '../../lib/analytics';
import { CornerDownLeft, Loader2 } from 'lucide-react';
import FolderPicker from '../ui/FolderPicker';
import FileAttachment from '../ui/FileAttachment';
import type { TaskConfigAttachment } from '@accomplish/shared';

interface TaskInputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  isLoading?: boolean;
  disabled?: boolean;
  large?: boolean;
  autoFocus?: boolean;
  workingDirectory?: string | null;
  onWorkingDirectoryChange?: (path: string | null) => void;
  attachments?: TaskConfigAttachment[];
  onAttachmentsChange?: (attachments: TaskConfigAttachment[]) => void;
  showControls?: boolean; // Show folder picker and file attachment
}

export default function TaskInputBar({
  value,
  onChange,
  onSubmit,
  placeholder = 'Assign a task or ask anything',
  isLoading = false,
  disabled = false,
  large = false,
  autoFocus = false,
  workingDirectory,
  onWorkingDirectoryChange,
  attachments,
  onAttachmentsChange,
  showControls = true,
}: TaskInputBarProps) {
  const isDisabled = disabled || isLoading;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accomplish = getAccomplish();

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2.5 shadow-sm transition-all duration-200 ease-accomplish focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
        {/* Text input */}
        <textarea
          data-testid="task-input-textarea"
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isDisabled}
          rows={1}
          className={`max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent text-foreground placeholder:text-gray-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${large ? 'text-[20px]' : 'text-sm'}`}
        />

        {/* File attachment button */}
        {showControls && (
          <FileAttachment
            attachments={attachments}
            onAttachmentsChange={onAttachmentsChange}
          />
        )}

        {/* Submit button */}
        <button
          data-testid="task-input-submit"
          type="button"
          onClick={() => {
            analytics.trackSubmitTask();
            accomplish.logEvent({
              level: 'info',
              message: 'Task input submit clicked',
              context: { prompt: value },
            });
            onSubmit();
          }}
          disabled={!value.trim() || isDisabled}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-all duration-200 ease-accomplish hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          title="Submit"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CornerDownLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Bottom controls: Folder picker */}
      {showControls && (
        <div className="flex items-center justify-between px-1">
          <FolderPicker
            value={workingDirectory}
            onChange={onWorkingDirectoryChange}
          />
        </div>
      )}
    </div>
  );
}
