// psi_affiliations.js
// Helper to find a person and return their affiliation for a specific year
function findPersonAffiliation(lastname, firstname, year, fullName) {
    if (!lastname) return null;

    const targetYear = parseInt(year, 10);
    // Note: We continue even if year is NaN to return "recent" data if possible

    // Normalize input
    const normLast = lastname.toLowerCase().trim();
    let normFirst = firstname ? firstname.toLowerCase().trim().replace(/\./g, '') : ""; // Remove dots from initials

    if (fullName) {
        const lowerFull = fullName.toLowerCase();
        if (lowerFull.includes(normLast)) {
            let temp = lowerFull.replace(normLast, '').replace(/,/g, '').trim();
            if (temp.length > normFirst.length) {
                normFirst = temp.replace(/\./g, '');
            }
        }
    }

    // Search through all keys
    const keys = Object.keys(PSI_HISTORY);
    let matchKey = null;

    for (const key of keys) {
        const parts = key.split(',');
        if (parts.length < 2) continue;

        const dbLast = parts[0].toLowerCase().trim();
        const dbFirst = parts[1].toLowerCase().trim().replace(/\./g, '');

        // 1. Lastname must match exactly
        if (dbLast !== normLast) continue;

        // 2. Firstname logic
        const dbFirstParts = dbFirst.split(/\s+/);
        const inFirstParts = normFirst.split(/\s+/);

        let isMatch = true;

        if (inFirstParts.length === 0 && dbFirstParts.length > 0) {
            continue;
        }

        for (let i = 0; i < inFirstParts.length; i++) {
            if (i >= dbFirstParts.length) break;

            const inPart = inFirstParts[i];
            const dbPart = dbFirstParts[i];

            if (inPart.length > 1 && dbPart.length > 1) {
                if (inPart !== dbPart) {
                    isMatch = false;
                    break;
                }
            } else {
                if (!dbPart.startsWith(inPart) && !inPart.startsWith(dbPart)) {
                    isMatch = false;
                    break;
                }
            }
        }

        if (isMatch) {
            matchKey = key;
            break;
        }
    }

    if (matchKey) {
        const records = PSI_HISTORY[matchKey];
        // records is now an array of arrays: [year, group, section, lab, division]

        // Find record for the specific year (index 0)
        const yearRecord = records.find(r => r[0] === targetYear);

        if (yearRecord) {
            return {
                found: true,
                name: matchKey,
                year: targetYear,
                units: [yearRecord[1], yearRecord[2], yearRecord[3], yearRecord[4]].filter(u => u),
                primaryUnit: yearRecord[1] || yearRecord[2] || yearRecord[3] || yearRecord[4],
                // Return specific fields for validation messages
                expectedGroup: yearRecord[1],
                expectedSection: yearRecord[2],
                expectedLab: yearRecord[3],
                expectedDivision: yearRecord[4]
            };
        } else {
            const sorted = records.sort((a, b) => b[0] - a[0]); // Sort by year (index 0)
            const recent = sorted[0]; // Most recent (descending sort)
            return {
                found: true,
                name: matchKey,
                year: null,
                availableYears: records.map(r => r[0]),
                recentUnit: recent[1] || recent[2] || recent[3] || recent[4],
                expectedGroup: recent[1],
                expectedSection: recent[2],
                expectedLab: recent[3],
                expectedDivision: recent[4]
            };
        }
    }

    return null;
}
