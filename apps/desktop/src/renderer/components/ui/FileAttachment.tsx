'use client';

import { useState } from 'react';
import { Paperclip, X, Image as ImageIcon, File } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { TaskConfigAttachment } from '@accomplish/shared';

interface FileAttachmentProps {
  attachments?: TaskConfigAttachment[];
  onAttachmentsChange?: (attachments: TaskConfigAttachment[]) => void;
  className?: string;
}

export default function FileAttachment({ attachments = [], onAttachmentsChange, className }: FileAttachmentProps) {
  const [loading, setLoading] = useState(false);

  const handleAddFiles = async () => {
    setLoading(true);
    try {
      // @ts-expect-error - Method not yet in type definitions
      const selectedFiles = await window.accomplish?.selectFiles({ multiple: true }) as TaskConfigAttachment[] | undefined;
      if (selectedFiles && selectedFiles.length > 0) {
        const newAttachments = [...attachments, ...selectedFiles];
        onAttachmentsChange?.(newAttachments);
      }
    } catch (error) {
      console.error('Failed to select files:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    const newAttachments = attachments.filter((_, i) => i !== index);
    onAttachmentsChange?.(newAttachments);
  };

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={loading}
            title="Add files or photos"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={handleAddFiles} disabled={loading}>
            Add files or photos
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Display attached files as chips */}
      {attachments.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {attachments.map((attachment, index) => (
            <div
              key={index}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-xs text-muted-foreground hover:text-foreground group"
            >
              {attachment.type === 'image' ? (
                <ImageIcon className="h-3 w-3" />
              ) : (
                <File className="h-3 w-3" />
              )}
              <span className="max-w-[100px] truncate">{attachment.name}</span>
              {attachment.size && (
                <span className="text-muted-foreground/70">({formatFileSize(attachment.size)})</span>
              )}
              <button
                onClick={() => handleRemoveAttachment(index)}
                className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove attachment"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
