import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";

const Login = lazy(() => import("./pages/Login"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Projects = lazy(() => import("./pages/Projects"));
const NewProject = lazy(() => import("./pages/NewProject"));
const TimeLogger = lazy(() => import("./pages/TimeLogger"));
const AIBrain = lazy(() => import("./pages/AIBrain"));
const Settings = lazy(() => import("./pages/Settings"));
const NotFound = lazy(() => import("./pages/NotFound"));
const FrameIOCallback = lazy(() => import("./pages/FrameIOCallback"));

const queryClient = new QueryClient();
const routeLoadingFallback = (
  <div className="min-h-screen w-full bg-background flex items-center justify-center text-sm text-muted-foreground">
    Loading...
  </div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={routeLoadingFallback}>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<Login />} />
              
              {/* OAuth callback routes - NOT protected to allow redirect from external OAuth */}
              <Route path="/integrations/frameio/callback" element={<FrameIOCallback />} />
              
              {/* Redirect root to dashboard */}
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              
              {/* Protected routes */}
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/projects"
                element={
                  <ProtectedRoute>
                    <Projects />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/projects/new"
                element={
                  <ProtectedRoute requiredRole={["admin", "producer"]}>
                    <NewProject />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/projects/:id"
                element={
                  <ProtectedRoute>
                    <Projects />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/time-logger"
                element={
                  <ProtectedRoute>
                    <TimeLogger />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/ai-brain"
                element={
                  <ProtectedRoute>
                    <AIBrain />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/settings"
                element={
                  <ProtectedRoute requiredRole="admin">
                    <Settings />
                  </ProtectedRoute>
                }
              />
              
              {/* 404 */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
