'use client';

import { useState, useEffect } from 'react';
import { Folder, ChevronDown, X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface RecentFolder {
  path: string;
  name: string;
  lastUsed: number;
}

interface FolderPickerProps {
  value?: string | null; // Current folder path
  onChange?: (path: string | null) => void;
  className?: string;
}

export default function FolderPicker({ value, onChange, className }: FolderPickerProps) {
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>([]);
  const [loading, setLoading] = useState(false);

  // Load recent folders on mount
  useEffect(() => {
    loadRecentFolders();
  }, []);

  const loadRecentFolders = async () => {
    try {
      // @ts-expect-error - Method not yet in type definitions
      const folders = await window.accomplish?.getRecentFolders();
      if (folders) {
        setRecentFolders(folders);
      }
    } catch (error) {
      console.error('Failed to load recent folders:', error);
    }
  };

  const handleSelectFolder = async () => {
    setLoading(true);
    try {
      // @ts-expect-error - Method not yet in type definitions
      const result = await window.accomplish?.selectFolder();
      if (result) {
        onChange?.(result.path);
        // Reload recent folders to show the newly selected one
        await loadRecentFolders();
      }
    } catch (error) {
      console.error('Failed to select folder:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectRecentFolder = (path: string) => {
    onChange?.(path);
  };

  const handleClear = () => {
    onChange?.(null);
  };

  // Format display name (username/folder or just folder name)
  const getDisplayName = (path: string): string => {
    if (!path) return 'No folder selected';
    
    const parts = path.split('/');
    const folderName = parts[parts.length - 1];
    
    // Try to extract username from path (e.g., /Users/username/Code/project -> username/project)
    const usersIndex = parts.findIndex(p => p === 'Users');
    if (usersIndex >= 0 && parts.length > usersIndex + 2) {
      const username = parts[usersIndex + 1];
      return `${username}/${folderName}`;
    }
    
    return folderName;
  };

  const currentDisplayName = value ? getDisplayName(value) : 'No folder selected';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-2 text-xs font-normal text-muted-foreground hover:text-foreground"
            disabled={loading}
          >
            <Folder className="h-3 w-3" />
            <span className="max-w-[120px] truncate">{currentDisplayName}</span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[280px]">
          {recentFolders.map((folder) => (
            <DropdownMenuItem
              key={folder.path}
              onClick={() => handleSelectRecentFolder(folder.path)}
              className={cn(
                'flex flex-col items-start gap-1 py-2',
                value === folder.path && 'bg-muted'
              )}
            >
              <div className="flex items-center gap-2 w-full">
                <Folder className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-sm truncate flex-1">{folder.name}</span>
                {value === folder.path && (
                  <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </div>
              <span className="text-xs text-muted-foreground truncate w-full pl-6">{folder.path}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSelectFolder} disabled={loading}>
            <Plus className="h-4 w-4 mr-2" />
            Choose a different folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {value && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClear}
          className="h-8 w-8 p-0"
          title="Clear folder selection"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
