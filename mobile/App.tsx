// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './src/store/auth';
import { parseDeepLink, type AppRoute, type AppRouteName } from './src/lib/deepLink';
import { colors } from './src/lib/format';
import { defaultSettings, loadSettings, saveSettings, type AppSettings } from './src/lib/storage';
import { useLocation } from './src/hooks/useLocation';
import {
  useCityWidgetSync,
  useNearbyAssets,
  useProductInfo,
  usePublicAssets,
  usePublicIncidents,
} from './src/hooks/useCityData';
import { useCityNotifications } from './src/hooks/useCityNotifications';
import { cityApi } from './src/api/city';
import { HomeScreen } from './src/screens/HomeScreen';
import { MapScreen } from './src/screens/MapScreen';
import { ScanScreen } from './src/screens/ScanScreen';
import { ReportScreen } from './src/screens/ReportScreen';
import { AlertsScreen } from './src/screens/AlertsScreen';
import { AccountScreen } from './src/screens/AccountScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { AssetDetailScreen } from './src/screens/AssetDetailScreen';
import { IncidentDetailScreen } from './src/screens/IncidentDetailScreen';
import { WidgetHelpScreen } from './src/screens/WidgetHelpScreen';
import { TabBar } from './src/components/TabBar';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const tabRoutes: AppRouteName[] = ['home', 'map', 'scan', 'alerts', 'account'];

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style="dark" />
        <AppShell />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AppShell() {
  const { loading: authLoading } = useAuth();
  const queryClientInstance = useQueryClient();
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [tab, setTab] = useState<AppRouteName>('home');
  const [stack, setStack] = useState<AppRoute[]>([{ name: 'home' }]);
  const [lastSync, setLastSync] = useState<number | null>(null);

  const productQuery = useProductInfo();
  const assetsQuery = usePublicAssets();
  const incidentsQuery = usePublicIncidents();
  const mapConfigQuery = useQuery({
    queryKey: ['city', 'map-config'],
    queryFn: cityApi.getMapConfig,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const locationState = useLocation();

  useEffect(() => {
    loadSettings()
      .then(setSettings)
      .finally(() => setSettingsLoading(false));
  }, []);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next).catch(() => undefined);
  }, []);

  const nearby = useNearbyAssets(assetsQuery.data, locationState.location, 5_000);
  const online = productQuery.isSuccess;

  useCityWidgetSync(
    locationState.location,
    assetsQuery.data,
    online,
  );
  useCityNotifications(incidentsQuery.data, locationState.location, settings);

  const refreshAll = useCallback(() => {
    productQuery.refetch().catch(() => undefined);
    assetsQuery.refetch().catch(() => undefined);
    incidentsQuery.refetch().catch(() => undefined);
    locationState.refresh(false).catch(() => undefined);
    setLastSync(Date.now());
  }, [productQuery, assetsQuery, incidentsQuery, locationState]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshAll();
    });
    return () => subscription.remove();
  }, [refreshAll]);

  const navigate = useCallback((route: AppRoute) => {
    setStack((current) => [...current, route]);
  }, []);

  const goTab = useCallback((route: AppRouteName) => {
    setTab(route);
    setStack([{ name: route }]);
  }, []);

  const goBack = useCallback(() => {
    setStack((current) => {
      if (current.length > 1) return current.slice(0, -1);
      if (tab !== 'home') {
        setTab('home');
        return [{ name: 'home' }];
      }
      return current;
    });
  }, [tab]);

  useEffect(() => {
    const handleUrl = (url: string | null) => {
      const route = parseDeepLink(url);
      if (route) {
        if (tabRoutes.includes(route.name)) {
          goTab(route.name);
        } else {
          setStack((current) => [...current, route]);
        }
      }
    };
    Linking.getInitialURL().then(handleUrl).catch(() => undefined);
    const subscription = Linking.addEventListener('url', (event) => handleUrl(event.url));
    return () => subscription.remove();
  }, [goTab]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        setStack((current) => current.slice(0, -1));
        return true;
      }
      if (tab !== 'home') {
        setTab('home');
        setStack([{ name: 'home' }]);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [stack.length, tab]);

  const current: AppRoute = stack[stack.length - 1] ?? { name: 'home' };

  if (authLoading || settingsLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.cyan} size="large" />
        <Text style={styles.loadingText}>SynapseCity</Text>
      </View>
    );
  }

  const tabVisible = tabRoutes.includes(current.name);
  const content = (() => {
    switch (current.name) {
      case 'home':
        return (
          <HomeScreen
            location={locationState.location}
            locationState={locationState.state}
            nearby={nearby}
            assets={assetsQuery.data ?? []}
            incidents={incidentsQuery.data ?? []}
            online={online}
            productVersion={productQuery.data?.version}
            refreshing={assetsQuery.isFetching || incidentsQuery.isFetching}
            onRefresh={refreshAll}
            navigate={navigate}
            onTab={goTab}
          />
        );
      case 'map':
        return (
          <MapScreen
            location={locationState.location}
            assets={assetsQuery.data ?? []}
            incidents={incidentsQuery.data ?? []}
            nearby={nearby}
            mapConfig={mapConfigQuery.data}
            mapConfigLoading={mapConfigQuery.isLoading}
            navigate={navigate}
          />
        );
      case 'scan':
        return <ScanScreen navigate={navigate} onBack={goBack} />;
      case 'report':
        return (
          <ReportScreen
            location={locationState.location}
            navigate={navigate}
            onBack={goBack}
            initialAssetCode={current.params?.assetCode}
          />
        );
      case 'alerts':
        return (
          <AlertsScreen
            incidents={incidentsQuery.data ?? []}
            incidentsError={incidentsQuery.error ? 'Không tải được danh sách sự cố công khai.' : null}
            onRetry={refreshAll}
            navigate={navigate}
            onAccount={() => goTab('account')}
          />
        );
      case 'account':
        return (
          <AccountScreen
            navigate={navigate}
            onBack={goBack}
            onLoggedIn={() => {
              queryClientInstance.invalidateQueries({ queryKey: ['city', 'alerts'] });
              queryClientInstance.invalidateQueries({ queryKey: ['city', 'notifications'] });
            }}
          />
        );
      case 'settings':
        return (
          <SettingsScreen
            settings={settings}
            onChange={updateSettings}
            location={locationState.location}
            locationState={locationState.state}
            locationMessage={locationState.message}
            onRefreshLocation={() => locationState.refresh(true).catch(() => undefined)}
            online={online}
            productVersion={productQuery.data?.version}
            navigate={navigate}
            onBack={goBack}
          />
        );
      case 'asset':
        return (
          <AssetDetailScreen
            code={current.params?.code || ''}
            location={locationState.location}
            navigate={navigate}
            onBack={goBack}
          />
        );
      case 'incident':
        return (
          <IncidentDetailScreen
            reference={current.params?.reference || ''}
            location={locationState.location}
            navigate={navigate}
            onBack={goBack}
          />
        );
      case 'widget-help':
        return (
          <WidgetHelpScreen
            location={locationState.location}
            assets={assetsQuery.data ?? []}
            nearby={nearby}
            onBack={goBack}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <View style={styles.root}>
      <View style={styles.content}>{content}</View>
      {tabVisible ? <TabBar active={tab} onNavigate={goTab} /> : null}
      {lastSync ? (
        <View style={styles.syncBadge} pointerEvents="none">
          <Text style={styles.syncText}>
            Đồng bộ {new Date(lastSync).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1 },
  loading: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  loadingText: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
  syncBadge: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  syncText: { color: colors.textDim, fontSize: 8, fontWeight: '600' },
});
