function pad(value) {
    return String(value).padStart(2, "0");
}

function formatTime(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.slice(0, 5);

    if (value instanceof Date) {
        return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
    }

    return String(value).slice(0, 5);
}

function formatDateTime(value) {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

module.exports = { formatTime, formatDateTime };
