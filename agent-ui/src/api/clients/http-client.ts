/**
 * ============================================================================
 * HTTP Client - Axios-based HTTP client with authentication and error handling
 * ============================================================================
 *
 * Features:
 * - Auto authentication token injection
 * - Request/Response interceptors
 * - Unified error handling
 * - BigInt JSON parsing support
 * - Request timeout management
 */

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse, type AxiosError } from 'axios'
import { defaultApiBaseUrl } from './runtime-url'

// ============================================================================
// Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean
  data: T
  message?: string
  code?: number
}

export interface ApiError {
  message: string
  code?: number
  details?: Record<string, unknown>
}

export interface HttpClientConfig {
  baseURL: string
  timeout?: number
  withCredentials?: boolean
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 30000
const TOKEN_KEY = 'omni_auth_token'

// ============================================================================
// HTTP Client Class
// ============================================================================

class HttpClient {
  private instance: AxiosInstance
  private baseURL: string

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL

    this.instance = axios.create({
      baseURL: config.baseURL,
      timeout: config.timeout || DEFAULT_TIMEOUT,
      withCredentials: config.withCredentials ?? false,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    this.setupInterceptors()
  }

  // --------------------------------------------------------------------------
  // Interceptor Setup
  // --------------------------------------------------------------------------

  private setupInterceptors(): void {
    // Request interceptor - Add auth token
    this.instance.interceptors.request.use(
      (config) => {
        const token = this.getToken()
        if (token && config.headers) {
          config.headers.Authorization = `Bearer ${token}`
        }
        return config
      },
      (error) => Promise.reject(error)
    )

    // Response interceptor - Handle errors
    this.instance.interceptors.response.use(
      (response) => this.handleResponse(response),
      (error) => this.handleError(error)
    )
  }

  // --------------------------------------------------------------------------
  // Response Handling
  // --------------------------------------------------------------------------

  private handleResponse<T>(response: AxiosResponse<T>): AxiosResponse<T> {
    // Check if the response contains a success flag and handle business errors
    const data = response.data as any
    if (data && typeof data === 'object' && 'success' in data && data.success === false) {
      // Business error (e.g., 404, validation error) returned with 200 status
      const apiError: ApiError = {
        message: data.message || data.error || 'Request failed',
        code: 400, // Use 400 for business errors
        details: data.data as Record<string, unknown>
      }
      return Promise.reject(apiError) as never
    }
    return response
  }

  private handleError(error: AxiosError): Promise<never> {
    const apiError: ApiError = {
      message: 'Unknown error occurred',
    }

    if (error.response) {
      const status = error.response.status
      const data = error.response.data as Record<string, unknown>

      // Helper function to extract error message from various response formats
      const getErrorMessage = (): string => {
        // Format 1: { error: { message: "..." }, is_success: false } (Backend exception handler)
        if (data?.error && typeof data.error === 'object' && 'message' in data.error) {
          return String((data.error as { message: string }).message)
        }
        // Format 2: { message: "...", success: false } (BaseResponse with success=false)
        if (typeof data?.message === 'string' && data?.success === false) {
          return String(data.message)
        }
        // Format 3: { detail: "..." } (FastAPI default validation error)
        if (typeof data?.detail === 'string') {
          return String(data.detail)
        }
        // Format 4: { message: "..." } (Direct message)
        if (typeof data?.message === 'string') {
          return String(data.message)
        }
        // Format 5: { error: "..." } (Direct error field)
        if (typeof data?.error === 'string') {
          return String(data.error)
        }
        return `HTTP Error: ${status}`
      }

      // Handle specific HTTP status codes
      switch (status) {
        case 401:
          // Unauthorized - Clear token and redirect to login
          this.clearToken()
          apiError.message = 'Authentication required'
          apiError.code = 401
          break
        case 403:
          {
            const message = getErrorMessage()
            apiError.message = message === `HTTP Error: ${status}` ? 'Access forbidden' : message
          }
          apiError.code = 403
          break
        case 404:
          apiError.message = getErrorMessage() || 'Resource not found'
          apiError.code = 404
          break
        case 409:
          // Conflict - Business logic error (e.g., project has active changes)
          apiError.message = getErrorMessage()
          apiError.code = 409
          apiError.details = data as Record<string, unknown>
          break
        case 422:
          apiError.message = getErrorMessage() || 'Validation error'
          apiError.code = 422
          apiError.details = data?.details as Record<string, unknown>
          break
        case 400:
          apiError.message = getErrorMessage() || 'Bad Request'
          apiError.code = 400
          apiError.details = data?.details as Record<string, unknown>
          break
        case 500:
          apiError.message = getErrorMessage() || 'Internal server error'
          apiError.code = 500
          break
        default:
          apiError.message = getErrorMessage()
          apiError.code = status
      }
    } else if (error.request) {
      apiError.message = 'Network error - no response received'
      apiError.code = 0
    } else {
      apiError.message = error.message || 'Request configuration error'
    }

    return Promise.reject(apiError)
  }

  // --------------------------------------------------------------------------
  // Token Management
  // --------------------------------------------------------------------------

  private getToken(): string | null {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(TOKEN_KEY)
    }
    return null
  }

  private clearToken(): void {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(TOKEN_KEY)
    }
  }

  public setToken(token: string): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem(TOKEN_KEY, token)
    }
  }

  // --------------------------------------------------------------------------
  // HTTP Methods
  // --------------------------------------------------------------------------

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
    const response = await this.instance.get<ApiResponse<T>>(url, config)
    return response.data
  }

  async post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
    const response = await this.instance.post<ApiResponse<T>>(url, data, config)
    return response.data
  }

  async put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
    const response = await this.instance.put<ApiResponse<T>>(url, data, config)
    return response.data
  }

  async patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
    const response = await this.instance.patch<ApiResponse<T>>(url, data, config)
    return response.data
  }

  async delete<T>(url: string, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
    const response = await this.instance.delete<ApiResponse<T>>(url, config)
    return response.data
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  getBaseURL(): string {
    return this.baseURL
  }

  setBaseURL(baseURL: string): void {
    this.baseURL = baseURL
    this.instance.defaults.baseURL = baseURL
  }
}

// ============================================================================
// Default Instance
// ============================================================================

const defaultConfig: HttpClientConfig = {
  baseURL: defaultApiBaseUrl(),
  timeout: DEFAULT_TIMEOUT,
}

export const http = new HttpClient(defaultConfig)

export default HttpClient
