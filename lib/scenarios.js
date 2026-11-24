const MINUTE = 60_000;

export const baseline = 'c1001155538114e811e8ecf311904723aa131115';

export function scenarios({ serverProject, apmProject, fixedEnd }, now = Date.now()) {
  const end = fixedEnd ?? Math.floor((now - 20 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
  const fixed = { stime: end - 15 * MINUTE, etime: end };
  const server = { domain: 'server', projectCode: serverProject, path: 'v2/sys/server_base',
    matchKeys: ['time', '_id_'], compareFields: ['cpu', 'memory_pused'], limit: 500 };
  const series = { domain: 'timeseries', projectCode: apmProject, timeRange: '5m',
    matchKeys: ['time', '_id_'], expectedStepMs: 5000, limit: 100 };
  const stats = { domain: 'apm', projectCode: apmProject, fixed, limit: 100 };
  return [
    { ...server, id: 'server-relative', timeRange: '5m' },
    { ...server, id: 'server-absolute', fixed, repairTarget: true },
    { ...stats, id: 'apm-transactions', statisticsMode: 'transaction', path: 'mxql/app/stat_tx_pcode',
      matchKeys: ['time', 'tx_hash', 'oid', 'okind', 'pcode'],
      compareFields: ['tx_count', 'tx_error', 'tx_time_sum'], groupKeys: ['tx_hash'] },
    { ...stats, id: 'apm-exceptions', statisticsMode: 'exception', path: 'mxql/app/stat_error_pcode',
      matchKeys: ['time', 'classHash', 'serviceHash', 'msg', 'oid', 'errorSnapId'],
      compareFields: ['count'], groupKeys: ['classHash', 'serviceHash', 'msg'] },
    { ...series, id: 'apm-tps', path: 'v2/app/tps_pcode', compareFields: ['tps'] },
    { ...series, id: 'apm-error-series', path: 'v2/app/tx_error_pcode', compareFields: ['tx_error'] },
  ];
}
