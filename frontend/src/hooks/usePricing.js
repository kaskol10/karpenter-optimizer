import { useState, useEffect, useCallback } from 'react';
import { getPrice, getBulkPrices, getCacheStats } from '../lib/pricingCache';

/**
 * React hook for managing AWS EC2 instance pricing
 * Automatically caches prices in localStorage
 */
export function usePricing(instanceTypes = [], capacityType = 'on-demand', autoFetch = true) {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cacheStats, setCacheStats] = useState(null);

  // Load cache stats
  useEffect(() => {
    setCacheStats(getCacheStats());
  }, []);

  // Fetch prices for instance types
  const fetchPrices = useCallback(async (forceRefresh = false) => {
    if (!instanceTypes || instanceTypes.length === 0) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const results = await getBulkPrices(instanceTypes, capacityType, forceRefresh);
      setPrices(results);
      setCacheStats(getCacheStats());
    } catch (err) {
      setError(err.message || 'Failed to fetch prices');
      console.error('Error fetching prices:', err);
    } finally {
      setLoading(false);
    }
  }, [instanceTypes, capacityType]);

  // Auto-fetch on mount and when dependencies change
  useEffect(() => {
    if (autoFetch && instanceTypes && instanceTypes.length > 0) {
      fetchPrices();
    }
  }, [autoFetch, instanceTypes, capacityType, fetchPrices]);

  // Get price for a single instance type
  const getInstancePrice = useCallback(async (instanceType, forceRefresh = false) => {
    try {
      const result = await getPrice(instanceType, capacityType, forceRefresh);
      if (result) {
        setPrices(prev => ({
          ...prev,
          [instanceType]: result,
        }));
        setCacheStats(getCacheStats());
        return result;
      }
      return null;
    } catch (err) {
      console.error(`Error fetching price for ${instanceType}:`, err);
      return null;
    }
  }, [capacityType]);

  // Refresh all prices
  const refresh = useCallback(() => {
    fetchPrices(true);
  }, [fetchPrices]);

  return {
    prices,
    loading,
    error,
    cacheStats,
    fetchPrices,
    getInstancePrice,
    refresh,
  };
}

/**
 * Hook for getting a single instance price
 */
export function useInstancePrice(instanceType, capacityType = 'on-demand', autoFetch = true) {
  const [price, setPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchPrice = useCallback(async (forceRefresh = false) => {
    if (!instanceType) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await getPrice(instanceType, capacityType, forceRefresh);
      setPrice(result);
    } catch (err) {
      setError(err.message || 'Failed to fetch price');
      console.error(`Error fetching price for ${instanceType}:`, err);
    } finally {
      setLoading(false);
    }
  }, [instanceType, capacityType]);

  useEffect(() => {
    if (autoFetch && instanceType) {
      fetchPrice();
    }
  }, [autoFetch, instanceType, capacityType, fetchPrice]);

  const refresh = useCallback(() => {
    fetchPrice(true);
  }, [fetchPrice]);

  return {
    price: price?.price || null,
    source: price?.source || null,
    cached: price?.cached || false,
    loading,
    error,
    fetchPrice,
    refresh,
  };
}

