// Copyright © 2026 Betttech Global Ventures (BGV) Limited. All rights reserved. See LICENSE.
// Shared prices. Leave these empty and the app works on its own, with prices saved on each phone only.
// To turn sharing on, paste in your project's details from Supabase: Project Settings > API.
// The anon key is meant to be public. The database rules in supabase/schema.sql decide what it can do.
const SHARING = {
  url: "https://rpkzylmnnizvwjunpmdh.supabase.co",      // like "https://abcdefgh.supabase.co"
  anonKey: "sb_publishable_rJelk2yI9uyKD7GWyeezUw_FP0cQSwP",  // the "anon public" key
  minPrices: 10, // how many traveller prices an item needs before they replace the sample range
};

// Where "Leave a tip" goes, like "https://ko-fi.com/yourpage". Leave it empty and the tip links stay hidden.
const TIP_URL = "https://ko-fi.com/bulelife";
