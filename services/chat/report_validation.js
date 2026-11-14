const {chatError}=require('./db');

function reportInteger(value, label, {min=1,max=Number.MAX_SAFE_INTEGER,fallback}={}) {
  if(value===undefined && fallback!==undefined)return fallback;
  if(!['number','string'].includes(typeof value) || String(value).trim()===''
    || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) {
    throw chatError(400,'INVALID_REPORT_INPUT',`${label} không hợp lệ.`);
  }
  return Number(value);
}
function reportPagination({limit,offset}) {
  return {limit:Math.min(reportInteger(limit,'Số bản ghi',{fallback:50}),100),
    offset:reportInteger(offset,'Vị trí trang',{min:0,max:2147483647,fallback:0})};
}
function reportText(value,label,max,{allowEmpty=true}={}) {
  if(value===undefined || value===null)return null;
  if(typeof value!=='string' || value.trim().length>max || (!allowEmpty && !value.trim())) {
    throw chatError(400,'INVALID_REPORT_INPUT',`${label} không hợp lệ hoặc vượt quá ${max} ký tự.`);
  }
  return value.trim() || null;
}
module.exports={reportInteger,reportPagination,reportText};
