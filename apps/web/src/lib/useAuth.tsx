"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchAuthState, type AuthState, type UserRole } from "@/lib/api";

/**
 * Trạng thái đăng nhập dùng chung cho toàn dashboard.
 *
 * Nguồn sự thật là GET /api/auth/me của backend, KHÔNG phải localStorage: vai
 * trò quyết định người dùng thấy gì, mà thứ client tự nhớ được thì client cũng
 * tự sửa được. Ở đây chỉ cache trong RAM của tab.
 *
 * Lưu ý: backend còn chấp nhận danh tính "machine" (mở dashboard ngay trên máy
 * chủ, hoặc link `?t=`). Khi đó `authenticated` là true nhưng `user` là null -
 * mọi chỗ hiển thị tên người dùng phải chịu được null, đừng giả định có user.
 */

interface AuthContextValue extends AuthState {
  /** Chưa gọi xong /api/auth/me lần đầu - đừng điều hướng khi còn true */
  loading: boolean;
  /** Gọi lại sau khi đăng nhập/đăng xuất/đổi vai trò */
  refresh: () => Promise<void>;
  /** Vai trò hiện tại có đạt mức yêu cầu không */
  can: (need: UserRole) => boolean;
}

const RANK: Record<UserRole, number> = { viewer: 1, editor: 2, admin: 3 };

const EMPTY: AuthState = {
  authenticated: false,
  needsSetup: false,
  via: null,
  role: null,
  user: null,
};

const AuthContext = createContext<AuthContextValue>({
  ...EMPTY,
  loading: true,
  refresh: async () => {},
  can: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(EMPTY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchAuthState());
    } catch {
      // Backend chưa lên hoặc mất mạng - coi như chưa đăng nhập, màn hình
      // đăng nhập sẽ tự báo lỗi khi người dùng bấm gửi.
      setState(EMPTY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      loading,
      refresh,
      can: (need: UserRole) => (state.role ? RANK[state.role] >= RANK[need] : false),
    }),
    [state, loading, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
