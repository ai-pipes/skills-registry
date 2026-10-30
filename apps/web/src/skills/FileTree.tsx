import type { SkillView } from '@skills/contracts';
import { FileIcon, FileTextIcon, FolderIcon } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils.ts';
import { strings } from '@/strings.ts';

type SkillFile = SkillView['files'][number];

interface DirNode {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
}

interface FileNode {
  kind: 'file';
  name: string;
  file: SkillFile;
}

type TreeNode = DirNode | FileNode;

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  );
  for (const n of nodes) if (n.kind === 'dir') sortNodes(n.children);
  return nodes;
}

/** Flat `a/b/c.md` paths → nested folders, folders first, each level sorted by name. */
function buildTree(files: SkillFile[]): TreeNode[] {
  const root: DirNode = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      const path = dir.path === '' ? part : `${dir.path}/${part}`;
      let next = dir.children.find((c): c is DirNode => c.kind === 'dir' && c.name === part);
      if (!next) {
        next = { kind: 'dir', name: part, path, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: 'file', name: parts.at(-1) ?? file.path, file });
  }
  return sortNodes(root.children);
}

interface LevelProps {
  nodes: TreeNode[];
  depth: number;
  selected: string | undefined;
  onSelect: (path: string) => void;
}

function Level({ nodes, depth, selected, onSelect }: LevelProps) {
  // Indentation by depth without inline styles (CSP): one Tailwind class per level, capped.
  const indent = ['pl-2', 'pl-6', 'pl-10', 'pl-14', 'pl-18', 'pl-22'][Math.min(depth, 5)];
  return nodes.map((node) =>
    node.kind === 'dir' ? (
      <li key={`d:${node.path}`} role="treeitem" aria-expanded="true" aria-label={node.name}>
        <div className={cn('flex items-center gap-1.5 py-1 text-sm text-muted-foreground', indent)}>
          <FolderIcon aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{node.name}</span>
        </div>
        <ul role="group">
          <Level nodes={node.children} depth={depth + 1} selected={selected} onSelect={onSelect} />
        </ul>
      </li>
    ) : (
      <li key={`f:${node.file.path}`} role="none">
        <button
          type="button"
          role="treeitem"
          aria-selected={selected === node.file.path}
          title={node.file.path}
          onClick={() => onSelect(node.file.path)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-selected:bg-secondary aria-selected:font-medium',
            indent,
          )}
        >
          {node.file.binary ? (
            <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
      </li>
    ),
  );
}

export interface FileTreeProps {
  files: SkillFile[];
  /** Path of the open file. */
  selected?: string;
  onSelect: (path: string) => void;
}

/** The skill's files as a folder tree; clicking a file opens it. */
export function FileTree({ files, selected, onSelect }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  return (
    <ul role="tree" aria-label={strings.skill.files} className="flex flex-col">
      <Level nodes={tree} depth={0} selected={selected} onSelect={onSelect} />
    </ul>
  );
}
