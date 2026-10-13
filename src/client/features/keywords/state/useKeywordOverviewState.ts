import { useMemo } from "react";
import type { KeywordMode } from "@/client/features/keywords/keywordResearchTypes";
import type { KeywordResearchRow } from "@/types/keywords";
import { first } from "@/shared/index-reads";

export function useKeywordOverviewState({
  rows,
  searchedKeyword,
  selectedKeyword,
  hasSearched,
  isLoading,
  lastSearchError,
  keywordMode,
}: {
  rows: KeywordResearchRow[];
  searchedKeyword: string;
  selectedKeyword: KeywordResearchRow | null;
  hasSearched: boolean;
  isLoading: boolean;
  lastSearchError: boolean;
  keywordMode: KeywordMode;
}) {
  const hasExactMatchInResults = useMemo(() => {
    const normalizedSeed = searchedKeyword.trim().toLowerCase();
    if (!normalizedSeed || rows.length === 0) return false;
    return rows.some(
      (row) => row.keyword.trim().toLowerCase() === normalizedSeed,
    );
  }, [rows, searchedKeyword]);

  const showApproximateMatchNotice =
    hasSearched &&
    !isLoading &&
    !lastSearchError &&
    rows.length > 0 &&
    searchedKeyword.trim() !== "" &&
    !hasExactMatchInResults &&
    keywordMode !== "auto";

  // `?? null` rather than a `!`: the `find` below legitimately finds nothing when
  // the searched keyword is not among the rows, and that absence is what the
  // `overviewKeyword === null` branch downstream renders. A non-null assertion
  // would have asserted a match that may not exist.
  const overviewKeyword: KeywordResearchRow | null = useMemo(() => {
    // `?? null` is the widening: the memo can return `undefined` when neither
    // branch produces a row, and the declared type says `null` for that. Both
    // mean "there is no seed keyword", and only one of them is what the
    // `overviewKeyword === null` branch downstream reads.
    if (selectedKeyword) return selectedKeyword;
    if (searchedKeyword && rows.length > 0) {
      const seed = rows.find(
        (row) => row.keyword.toLowerCase() === searchedKeyword.toLowerCase(),
      );
      if (seed) return seed;
    }
    // `first()` rather than `rows[0]`: the `rows.length > 0` guard proves the
    // array is non-empty, and the compiler cannot see it — so `rows[0]` was
    // `KeywordResearchRow | undefined` and the memo's return type widened to
    // include `undefined`, which then failed the declared `| null`.
    return rows.length > 0 ? first(rows, "the keyword results") : null;
  }, [selectedKeyword, searchedKeyword, rows]);

  return { showApproximateMatchNotice, overviewKeyword };
}
