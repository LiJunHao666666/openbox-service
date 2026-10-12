'use strict';
/**
 * 类型化错误体系。
 *
 * 约定：
 *  - 凡是「能预期」的失败都抛 AppError 的子类，带上机器可读的 code。
 *  - 客户端只会看到 { error: { code, message } }，永远看不到堆栈、SQL 或内部细节。
 *  - 未继承 AppError 的异常一律按 500 处理，且只回一句通用文案。
 */

class AppError extends Error {
  /**
   * @param {string} code    机器可读错误码，前端可据此分支
   * @param {string} message 面向用户的中文提示
   * @param {object} [opts]
   * @param {number} [opts.status]  HTTP 状态码
   * @param {object} [opts.details] 附加上下文（只进日志，不回客户端）
   * @param {Array}  [opts.fields]  字段级错误 [{ field, message }]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = opts.status || 400;
    this.details = opts.details || null;
    this.fields = opts.fields || null;
    this.expose = true;
  }
}

/** 422 入参校验失败 */
class ValidationError extends AppError {
  constructor(message = '提交的内容有误，请检查后重试', fields = null) {
    super('VALIDATION_FAILED', message, { status: 422, fields });
  }
}

/** 401 未登录 / 会话失效 */
class UnauthorizedError extends AppError {
  constructor(message = '登录状态已失效，请重新登录') {
    super('UNAUTHORIZED', message, { status: 401 });
  }
}

/** 403 已登录但无权限 */
class ForbiddenError extends AppError {
  constructor(message = '你没有权限执行这个操作') {
    super('FORBIDDEN', message, { status: 403 });
  }
}

/** 404 资源不存在 */
class NotFoundError extends AppError {
  constructor(message = '没找到这条记录') {
    super('NOT_FOUND', message, { status: 404 });
  }
}

/** 409 状态冲突（例如重复接单） */
class ConflictError extends AppError {
  constructor(message = '当前状态不允许这个操作', details = null) {
    super('CONFLICT', message, { status: 409, details });
  }
}

/** 429 触发限流 */
class RateLimitError extends AppError {
  constructor(message = '操作太频繁了，请稍后再试', retryAfterSec = 60) {
    super('RATE_LIMITED', message, { status: 429, details: { retryAfterSec } });
    this.retryAfterSec = retryAfterSec;
  }
}

/** 413 请求体过大 */
class PayloadTooLargeError extends AppError {
  constructor(message = '提交的内容太大了') {
    super('PAYLOAD_TOO_LARGE', message, { status: 413 });
  }
}

/** 503 依赖不可用 */
class ServiceUnavailableError extends AppError {
  constructor(message = '服务暂时不可用，请稍后再试') {
    super('SERVICE_UNAVAILABLE', message, { status: 503 });
  }
}

function isAppError(e) {
  return e instanceof AppError;
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  isAppError,
};
