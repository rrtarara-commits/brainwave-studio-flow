import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AppRole } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Users, Shield, FileVideo, FolderOpen } from 'lucide-react';

interface UserWithRole {
  id: string;
  user_id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  can_manage_resources: boolean;
  can_upload_footage: boolean;
  role: AppRole | null;
}

export function UserManagement() {
  const [users, setUsers] = useState<UserWithRole[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchUsers = useCallback(async () => {
    try {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at');

      if (profilesError) throw profilesError;

      const { data: roles, error: rolesError } = await supabase
        .from('user_roles')
        .select('user_id, role');

      if (rolesError) throw rolesError;

      const rolesMap = new Map(roles?.map((r) => [r.user_id, r.role as AppRole]));

      const usersWithRoles: UserWithRole[] = (profiles || []).map((p) => ({
        id: p.id,
        user_id: p.user_id,
        email: p.email,
        full_name: p.full_name,
        avatar_url: p.avatar_url,
        can_manage_resources: p.can_manage_resources ?? false,
        can_upload_footage: p.can_upload_footage ?? false,
        role: rolesMap.get(p.user_id) ?? null,
      }));

      setUsers(usersWithRoles);
    } catch (error) {
      console.error('Error fetching users:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load users',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const updateRole = async (userId: string, newRole: AppRole) => {
    setUpdatingUser(userId);
    try {
      const { error } = await supabase
        .from('user_roles')
        .update({ role: newRole })
        .eq('user_id', userId);

      if (error) throw error;

      setUsers((prev) =>
        prev.map((u) => (u.user_id === userId ? { ...u, role: newRole } : u))
      );

      toast({
        title: 'Role updated',
        description: `User role changed to ${newRole}`,
      });
    } catch (error) {
      console.error('Error updating role:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to update role',
      });
    } finally {
      setUpdatingUser(null);
    }
  };

  const updatePermission = async (
    userId: string,
    field: 'can_manage_resources' | 'can_upload_footage',
    value: boolean
  ) => {
    setUpdatingUser(userId);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ [field]: value })
        .eq('user_id', userId);

      if (error) throw error;

      setUsers((prev) =>
        prev.map((u) => (u.user_id === userId ? { ...u, [field]: value } : u))
      );

      toast({
        title: 'Permission updated',
        description: `${field === 'can_manage_resources' ? 'Resource management' : 'Footage upload'} ${value ? 'enabled' : 'disabled'}`,
      });
    } catch (error) {
      console.error('Error updating permission:', error);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to update permission',
      });
    } finally {
      setUpdatingUser(null);
    }
  };

  const getInitials = (name: string | null, email: string | null) => {
    const source = name || email || '?';
    return source
      .split(/[@\s]/)
      .filter(Boolean)
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getRoleBadgeVariant = (role: AppRole | null) => {
    switch (role) {
      case 'admin':
        return 'destructive';
      case 'producer':
        return 'default';
      case 'editor':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  if (isLoading) {
    return (
      <Card className="glass-card">
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          User Management
        </CardTitle>
        <CardDescription>
          Manage user roles and specialist permissions. Admins have full access, Producers can manage projects, Editors can log time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <FolderOpen className="h-4 w-4" />
                    <span className="hidden sm:inline">Resources</span>
                  </div>
                </TableHead>
                <TableHead className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    <FileVideo className="h-4 w-4" />
                    <span className="hidden sm:inline">Footage</span>
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9 border border-border">
                        <AvatarImage src={user.avatar_url || undefined} />
                        <AvatarFallback className="bg-muted text-muted-foreground text-sm">
                          {getInitials(user.full_name, user.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col">
                        <span className="font-medium text-sm">
                          {user.full_name || user.email}
                        </span>
                        {user.full_name && (
                          <span className="text-xs text-muted-foreground">
                            {user.email}
                          </span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={user.role || 'editor'}
                      onValueChange={(value) => updateRole(user.user_id, value as AppRole)}
                      disabled={updatingUser === user.user_id}
                    >
                      <SelectTrigger className="w-[120px]">
                        <SelectValue>
                          <Badge variant={getRoleBadgeVariant(user.role)} className="capitalize">
                            {user.role || 'editor'}
                          </Badge>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">
                          <div className="flex items-center gap-2">
                            <Shield className="h-3 w-3 text-destructive" />
                            Admin
                          </div>
                        </SelectItem>
                        <SelectItem value="producer">
                          <div className="flex items-center gap-2">
                            <Shield className="h-3 w-3 text-primary" />
                            Producer
                          </div>
                        </SelectItem>
                        <SelectItem value="editor">
                          <div className="flex items-center gap-2">
                            <Shield className="h-3 w-3 text-muted-foreground" />
                            Editor
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={user.can_manage_resources}
                      onCheckedChange={(checked) =>
                        updatePermission(user.user_id, 'can_manage_resources', checked)
                      }
                      disabled={updatingUser === user.user_id}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={user.can_upload_footage}
                      onCheckedChange={(checked) =>
                        updatePermission(user.user_id, 'can_upload_footage', checked)
                      }
                      disabled={updatingUser === user.user_id}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="mt-4 p-4 rounded-lg bg-muted/50 border border-border">
          <p className="text-sm text-muted-foreground">
            <strong>Roles:</strong> Admin (full access) → Producer (manage projects) → Editor (log time only)
            <br />
            <strong>Specialist toggles:</strong> Grant access to Resources or Footage features regardless of role.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
