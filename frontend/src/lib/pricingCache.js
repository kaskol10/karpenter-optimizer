/**
 * Pricing Cache Utility
 * Manages AWS EC2 instance pricing cache in browser localStorage
 * Fetches prices from backend API and caches them locally
 */

const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

const CACHE_KEY_PREFIX = 'aws_pricing_';
const CACHE_VERSION = '1.0';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

/**
 * Get cache key for an instance type and capacity type
 */
function getCacheKey(instanceType, capacityType = 'on-demand') {
  return `${CACHE_KEY_PREFIX}${instanceType}_${capacityType}`;
}

/**
 * Get cache metadata key
 */
function getMetadataKey() {
  return `${CACHE_KEY_PREFIX}metadata`;
}

/**
 * Get cached price for an instance type
 */
export function getCachedPrice(instanceType, capacityType = 'on-demand') {
  try {
    const cacheKey = getCacheKey(instanceType, capacityType);
    const cached = localStorage.getItem(cacheKey);
    
    if (!cached) {
      return null;
    }

    const data = JSON.parse(cached);
    const now = Date.now();

    // Check if cache is expired
    if (now > data.expiresAt) {
      localStorage.removeItem(cacheKey);
      return null;
    }

    return {
      price: data.price,
      source: data.source,
      cachedAt: data.cachedAt,
      expiresAt: data.expiresAt,
    };
  } catch (error) {
    console.error('Error reading pricing cache:', error);
    return null;
  }
}

/**
 * Cache a price for an instance type
 */
export function setCachedPrice(instanceType, capacityType, price, source) {
  try {
    const cacheKey = getCacheKey(instanceType, capacityType);
    const now = Date.now();
    
    const data = {
      price,
      source,
      cachedAt: now,
      expiresAt: now + CACHE_TTL,
      version: CACHE_VERSION,
    };

    localStorage.setItem(cacheKey, JSON.stringify(data));
    
    // Update metadata
    updateCacheMetadata(instanceType, capacityType);
  } catch (error) {
    console.error('Error writing pricing cache:', error);
    // Handle quota exceeded error
    if (error.name === 'QuotaExceededError') {
      console.warn('localStorage quota exceeded, clearing old cache entries');
      clearExpiredCache();
    }
  }
}

/**
 * Update cache metadata
 */
function updateCacheMetadata(instanceType, capacityType) {
  try {
    const metadataKey = getMetadataKey();
    const metadata = JSON.parse(localStorage.getItem(metadataKey) || '{}');
    
    if (!metadata.entries) {
      metadata.entries = [];
    }

    const entryKey = `${instanceType}_${capacityType}`;
    if (!metadata.entries.includes(entryKey)) {
      metadata.entries.push(entryKey);
    }

    metadata.lastUpdated = Date.now();
    localStorage.setItem(metadataKey, JSON.stringify(metadata));
  } catch (error) {
    console.error('Error updating cache metadata:', error);
  }
}

/**
 * Clear expired cache entries
 */
export function clearExpiredCache() {
  try {
    const metadataKey = getMetadataKey();
    const metadata = JSON.parse(localStorage.getItem(metadataKey) || '{}');
    const entries = metadata.entries || [];
    const now = Date.now();
    let cleared = 0;

    entries.forEach(entryKey => {
      const [instanceType, capacityType] = entryKey.split('_');
      const cacheKey = getCacheKey(instanceType, capacityType);
      const cached = localStorage.getItem(cacheKey);
      
      if (cached) {
        try {
          const data = JSON.parse(cached);
          if (now > data.expiresAt) {
            localStorage.removeItem(cacheKey);
            cleared++;
          }
        } catch (error) {
          // Invalid cache entry, remove it
          localStorage.removeItem(cacheKey);
          cleared++;
        }
      }
    });

    if (cleared > 0) {
      console.log(`Cleared ${cleared} expired cache entries`);
    }
  } catch (error) {
    console.error('Error clearing expired cache:', error);
  }
}

/**
 * Clear all pricing cache
 */
export function clearAllCache() {
  try {
    const metadataKey = getMetadataKey();
    const metadata = JSON.parse(localStorage.getItem(metadataKey) || '{}');
    const entries = metadata.entries || [];

    entries.forEach(entryKey => {
      const [instanceType, capacityType] = entryKey.split('_');
      const cacheKey = getCacheKey(instanceType, capacityType);
      localStorage.removeItem(cacheKey);
    });

    localStorage.removeItem(metadataKey);
    console.log('Cleared all pricing cache');
  } catch (error) {
    console.error('Error clearing all cache:', error);
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  try {
    const metadataKey = getMetadataKey();
    const metadata = JSON.parse(localStorage.getItem(metadataKey) || '{}');
    const entries = metadata.entries || [];
    const now = Date.now();
    
    let total = 0;
    let expired = 0;
    let valid = 0;

    entries.forEach(entryKey => {
      const [instanceType, capacityType] = entryKey.split('_');
      const cacheKey = getCacheKey(instanceType, capacityType);
      const cached = localStorage.getItem(cacheKey);
      
      if (cached) {
        total++;
        try {
          const data = JSON.parse(cached);
          if (now > data.expiresAt) {
            expired++;
          } else {
            valid++;
          }
        } catch (error) {
          expired++;
        }
      }
    });

    return {
      total,
      valid,
      expired,
      lastUpdated: metadata.lastUpdated || null,
    };
  } catch (error) {
    console.error('Error getting cache stats:', error);
    return { total: 0, valid: 0, expired: 0, lastUpdated: null };
  }
}

/**
 * Fetch price from API and cache it
 */
export async function fetchAndCachePrice(instanceType, capacityType = 'on-demand') {
  try {
    const url = `${API_URL}/api/v1/pricing/${instanceType}?capacityType=${capacityType}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.pricePerHour !== undefined) {
      setCachedPrice(instanceType, capacityType, data.pricePerHour, data.source || 'unknown');
      return {
        price: data.pricePerHour,
        source: data.source || 'unknown',
      };
    }

    throw new Error('Invalid API response');
  } catch (error) {
    console.error(`Error fetching price for ${instanceType}:`, error);
    throw error;
  }
}

/**
 * Fetch multiple prices from API and cache them
 */
export async function fetchAndCacheBulkPrices(instanceTypes, capacityType = 'on-demand') {
  try {
    const instanceTypesParam = instanceTypes.join(',');
    const url = `${API_URL}/api/v1/pricing?instanceTypes=${encodeURIComponent(instanceTypesParam)}&capacityType=${capacityType}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const results = {};

    if (data.prices) {
      Object.entries(data.prices).forEach(([instanceType, priceInfo]) => {
        if (priceInfo.pricePerHour !== undefined) {
          setCachedPrice(instanceType, capacityType, priceInfo.pricePerHour, priceInfo.source || 'unknown');
          results[instanceType] = {
            price: priceInfo.pricePerHour,
            source: priceInfo.source || 'unknown',
          };
        }
      });
    }

    return results;
  } catch (error) {
    console.error('Error fetching bulk prices:', error);
    throw error;
  }
}

/**
 * Get price for an instance type (from cache or API)
 */
export async function getPrice(instanceType, capacityType = 'on-demand', forceRefresh = false) {
  // Check cache first (unless forcing refresh)
  if (!forceRefresh) {
    const cached = getCachedPrice(instanceType, capacityType);
    if (cached) {
      return {
        price: cached.price,
        source: cached.source,
        cached: true,
      };
    }
  }

  // Fetch from API
  try {
    const result = await fetchAndCachePrice(instanceType, capacityType);
    return {
      ...result,
      cached: false,
    };
  } catch (error) {
    // If API fails, return null (caller can handle fallback)
    return null;
  }
}

/**
 * Get prices for multiple instance types (from cache or API)
 */
export async function getBulkPrices(instanceTypes, capacityType = 'on-demand', forceRefresh = false) {
  // Check cache first (unless forcing refresh)
  const results = {};
  const missingTypes = [];

  if (!forceRefresh) {
    instanceTypes.forEach(instanceType => {
      const cached = getCachedPrice(instanceType, capacityType);
      if (cached) {
        results[instanceType] = {
          price: cached.price,
          source: cached.source,
          cached: true,
        };
      } else {
        missingTypes.push(instanceType);
      }
    });
  } else {
    missingTypes.push(...instanceTypes);
  }

  // Fetch missing types from API
  if (missingTypes.length > 0) {
    try {
      const apiResults = await fetchAndCacheBulkPrices(missingTypes, capacityType);
      Object.entries(apiResults).forEach(([instanceType, priceInfo]) => {
        results[instanceType] = {
          ...priceInfo,
          cached: false,
        };
      });
    } catch (error) {
      console.error('Error fetching bulk prices:', error);
      // Continue with cached results only
    }
  }

  return results;
}

// Clean up expired cache on load
if (typeof window !== 'undefined') {
  clearExpiredCache();
}

