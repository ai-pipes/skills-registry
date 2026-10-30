import {
  CircleUserIcon,
  FolderIcon,
  KeyRoundIcon,
  LibraryIcon,
  LogOutIcon,
  MenuIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { notify } from '@/lib/notify.ts';
import { useAuth } from '@/auth/AuthProvider.tsx';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useHasUnsavedChanges } from '@/lib/unsavedChanges.ts';
import { strings } from '@/strings.ts';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/skills', label: strings.nav.skills, icon: LibraryIcon },
  { to: '/folders', label: strings.nav.folders, icon: FolderIcon },
  { to: '/tokens', label: strings.nav.tokens, icon: KeyRoundIcon },
  { to: '/users', label: strings.nav.users, icon: UsersIcon, adminOnly: true },
];

/** Section list, the signed-in login and "Sign out"; shared by the sidebar and the mobile sheet. */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { me, logout } = useAuth();
  const { pathname } = useLocation();
  const isAdmin = me?.role === 'admin';
  // An editor with unsaved changes: "Sign out" asks first, like leaving the page would.
  const unsaved = useHasUnsavedChanges();
  const [confirmLogout, setConfirmLogout] = useState(false);

  async function onLogout() {
    try {
      await logout();
    } catch {
      // Still signed in (logout() re-fetched /me); the user must know the session is alive.
      notify.error(strings.auth.logoutFailed);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-2.5 pt-1 text-lg font-semibold">{strings.app.title}</div>
      <nav aria-label={strings.nav.label} className="flex flex-col gap-1">
        {NAV.filter((item) => isAdmin || !item.adminOnly).map(({ to, label, icon: Icon }) => {
          const active = pathname === to || pathname.startsWith(`${to}/`);
          return (
            // A real link styled as `Button` (ghost / secondary when active): Base UI's Button
            // would give the anchor role="button".
            <Link
              key={to}
              to={to}
              className={buttonVariants({
                variant: active ? 'secondary' : 'ghost',
                className: 'justify-start',
              })}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
            >
              <Icon aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" className="w-full justify-start" />}>
            <CircleUserIcon aria-hidden />
            <span className="truncate">{me?.login}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top">
            <DropdownMenuItem onClick={() => (unsaved ? setConfirmLogout(true) : void onLogout())}>
              <LogOutIcon aria-hidden />
              {strings.nav.logout}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmDialog
          open={confirmLogout}
          onOpenChange={setConfirmLogout}
          title={strings.editor.leaveTitle}
          description={strings.editor.leaveDescription}
          confirmLabel={strings.nav.logout}
          destructive
          onConfirm={onLogout}
        />
      </div>
    </div>
  );
}

/**
 * App shell: navigation on the left, content on the right. Below 768 px (`md`) the sidebar is
 * hidden and the same navigation opens in a `Sheet` from the top bar.
 */
export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-60 shrink-0 border-r md:block">
        <div className="sticky top-0 h-svh">
          <Sidebar />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4 md:hidden">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              render={<Button variant="ghost" size="icon" aria-label={strings.nav.openMenu} />}
            >
              <MenuIcon aria-hidden />
            </SheetTrigger>
            <SheetContent side="left" className="w-64 gap-0 p-0">
              <SheetTitle className="sr-only">{strings.nav.label}</SheetTitle>
              <Sidebar onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="font-semibold">{strings.app.title}</span>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
