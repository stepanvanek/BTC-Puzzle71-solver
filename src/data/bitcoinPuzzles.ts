import type { Locale } from '../i18n/locale.ts';
import { BLOCK_SIZE } from '../shared/puzzle71.ts';

export type BitcoinPuzzleStatus = 'solved' | 'active' | 'unsolved';

export interface BitcoinPuzzleRecord {
  bits: number;
  address: string;
  hexStart: string;
  hexEnd: string;
  rewardBtc: number;
  status: BitcoinPuzzleStatus;
  pubkeyExposed: boolean;
  solvedKeyHex?: string;
  solvedPercent?: number;
  solvedDate?: string;
  note: string;
  noteCs: string;
}

type RawPuzzleTuple = readonly [
  bits: number,
  address: string,
  solvedKeyHex: string | null,
  rewardBtc: number,
  solvedDate?: string,
];

const RAW_PUZZLES: readonly RawPuzzleTuple[] = [
  [1, '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', '0x1', 0.001, '2015-01-15'],
  [2, '1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb', '0x3', 0.002, '2015-01-15'],
  [3, '19ZewH8Kk1PDbSNdJ97FP4EiCjTRaZMZQA', '0x7', 0.003, '2015-01-15'],
  [4, '1EhqbyUMvvs7BfL8goY6qcPbD6YKfPqb7e', '0x8', 0.004, '2015-01-15'],
  [5, '1E6NuFjCi27W5zoXg8TRdcSRq84zJeBW3k', '0x15', 0.005, '2015-01-15'],
  [6, '1PitScNLyp2HCygzadCh7FveTnfmpPbfp8', '0x31', 0.006, '2015-01-15'],
  [7, '1McVt1vMtCC7yn5b9wgX1833yCcLXzueeC', '0x4c', 0.007, '2015-01-15'],
  [8, '1M92tSqNmQLYw33fuBvjmeadirh1ysMBxK', '0xe0', 0.008, '2015-01-15'],
  [9, '1CQFwcjw1dwhtkVWBttNLDtqL7ivBonGPV', '0x1d3', 0.009, '2015-01-15'],
  [10, '1LeBZP5QCwwgXRtmVUvTVrraqPUokyLHqe', '0x202', 0.01, '2015-01-15'],
  [11, '1PgQVLmst3Z314JrQn5TNiys8Hc38TcXJu', '0x483', 0.011, '2015-01-15'],
  [12, '1DBaumZxUkM4qMQRt2LVWyFJq5kDtSZQot', '0xa7b', 0.012, '2015-01-15'],
  [13, '1Pie8JkxBT6MGPz9Nvi3fsPkr2D8q3GBc1', '0x1460', 0.013, '2015-01-15'],
  [14, '1ErZWg5cFCe4Vw5BzgfzB74VNLaXEiEkhk', '0x2930', 0.014, '2015-01-15'],
  [15, '1QCbW9HWnwQWiQqVo5exhAnmfqKRrCRsvW', '0x68f3', 0.015, '2015-01-15'],
  [16, '1BDyrQ6WoF8VN3g9SAS1iKZcPzFfnDVieY', '0xc936', 0.016, '2015-01-15'],
  [17, '1HduPEXZRdG26SUT5Yk83mLkPyjnZuJ7Bm', '0x1764f', 0.017, '2015-01-15'],
  [18, '1GnNTmTVLZiqQfLbAdp9DVdicEnB5GoERE', '0x3080d', 0.018, '2015-01-15'],
  [19, '1NWmZRpHH4XSPwsW6dsS3nrNWfL1yrJj4w', '0x5749f', 0.019, '2015-01-15'],
  [20, '1HsMJxNiV7TLxmoF6uJNkydxPFDog4NQum', '0xd2c55', 0.02, '2015-01-15'],
  [21, '14oFNXucftsHiUMY8uctg6N487riuyXs4h', '0x1ba534', 0.021, '2015-01-15'],
  [22, '1CfZWK1QTQE3eS9qn61dQjV89KDjZzfNcv', '0x2de40f', 0.022, '2015-01-15'],
  [23, '1L2GM8eE7mJWLdo3HZS6su1832NX2txaac', '0x556e52', 0.023, '2015-01-15'],
  [24, '1rSnXMr63jdCuegJFuidJqWxUPV7AtUf7', '0xdc2a04', 0.024, '2015-01-15'],
  [25, '15JhYXn6Mx3oF4Y7PcTAv2wVVAuCFFQNiP', '0x1fa5ee5', 0.025, '2015-01-15'],
  [26, '1JVnST957hGztonaWK6FougdtjxzHzRMMg', '0x340326e', 0.026, '2015-01-15'],
  [27, '128z5d7nN7PkCuX5qoA4Ys6pmxUYnEy86k', '0x6ac3875', 0.027, '2015-01-15'],
  [28, '12jbtzBb54r97TCwW3G1gCFoumpckRAPdY', '0xd916ce8', 0.028, '2015-01-15'],
  [29, '19EEC52krRUK1RkUAEZmQdjTyHT7Gp1TYT', '0x17e2551e', 0.029, '2015-01-15'],
  [30, '1LHtnpd8nU5VHEMkG2TMYYNUjjLc992bps', '0x3d94cd64', 0.03, '2015-01-15'],
  [31, '1LhE6sCTuGae42Axu1L1ZB7L96yi9irEBE', '0x7d4fe747', 0.031, '2015-01-15'],
  [32, '1FRoHA9xewq7DjrZ1psWJVeTer8gHRqEvR', '0xb862a62e', 0.032, '2015-01-15'],
  [33, '187swFMjz1G54ycVU56B7jZFHFTNVQFDiu', '0x1a96ca8d8', 0.033, '2015-01-15'],
  [34, '1PWABE7oUahG2AFFQhhvViQovnCr4rEv7Q', '0x34a65911d', 0.034, '2015-01-15'],
  [35, '1PWCx5fovoEaoBowAvF5k91m2Xat9bMgwb', '0x4aed21170', 0.035, '2015-01-15'],
  [36, '1Be2UF9NLfyLFbtm3TCbmuocc9N1Kduci1', '0x9de820a7c', 0.036, '2015-01-15'],
  [37, '14iXhn8bGajVWegZHJ18vJLHhntcpL4dex', '0x1757756a93', 0.037, '2015-01-15'],
  [38, '1HBtApAFA9B2YZw3G2YKSMCtb3dVnjuNe2', '0x22382facd0', 0.038, '2015-01-15'],
  [39, '122AJhKLEfkFBaGAd84pLp1kfE7xK3GdT8', '0x4b5f8303e9', 0.039, '2015-01-15'],
  [40, '1EeAxcprB2PpCnr34VfZdFrkUWuxyiNEFv', '0xe9ae4933d6', 0.04, '2015-01-15'],
  [41, '1L5sU9qvJeuwQUdt4y1eiLmquFxKjtHr3E', '0x153869acc5b', 0.041],
  [42, '1E32GPWgDyeyQac4aJxm9HVoLrrEYPnM4N', '0x2a221c58d8f', 0.042],
  [43, '1PiFuqGpG8yGM5v6rNHWS3TjsG6awgEGA1', '0x6bd3b27c591', 0.043],
  [44, '1CkR2uS7LmFwc3T2jV8C1BhWb5mQaoxedF', '0xe02b35a358f', 0.044],
  [45, '1NtiLNGegHWE3Mp9g2JPkgx6wUg4TW7bbk', '0x122fca143c05', 0.045],
  [46, '1F3JRMWudBaj48EhwcHDdpeuy2jwACNxjP', '0x2ec18388d544', 0.046],
  [47, '1Pd8VvT49sHKsmqrQiP61RsVwmXCZ6ay7Z', '0x6cd610b53cba', 0.047],
  [48, '1DFYhaB2J9q1LLZJWKTnscPWos9VBqDHzv', '0xade6d7ce3b9b', 0.048],
  [49, '12CiUhYVTTH33w3SPUBqcpMoqnApAV4WCF', '0x174176b015f4d', 0.049],
  [50, '1MEzite4ReNuWaL5Ds17ePKt2dCxWEofwk', '0x22bd43c2e9354', 0.05],
  [51, '1NpnQyZ7x24ud82b7WiRNvPm6N8bqGQnaS', '0x75070a1a009d4', 0.051],
  [52, '15z9c9sVpu6fwNiK7dMAFgMYSK4GqsGZim', '0xefae164cb9e3c', 0.052],
  [53, '15K1YKJMiJ4fpesTVUcByoz334rHmknxmT', '0x180788e47e326c', 0.53],
  [54, '1KYUv7nSvXx4642TKeuC2SNdTk326uUpFy', '0x236fb6d5ad1f43', 0.54],
  [55, '1LzhS3k3e9Ub8i2W1V8xQFdB8n2MYCHPCa', '0x6abe1f9b67e114', 0.55],
  [56, '17aPYR1m6pVAacXg1PTDDU7XafvK1dxvhi', '0x9d18b63ac4ffdf', 0.56],
  [57, '15c9mPGLku1HuW9LRtBf4jcHVpBUt8txKz', '0x1eb25c90795d61c', 0.57],
  [58, '1Dn8NF8qDyyfHMktmuoQLGyjWmZXgvosXf', '0x2c675b852189a21', 0.58],
  [59, '1HAX2n9Uruu9YDt4cqRgYcvtGvZj1rbUyt', '0x7496cbb87cab44f', 0.59],
  [60, '1Kn5h2qpgw9mWE5jKpk8PP4qvvJ1QVy8su', '0xfc07a1825367bbe', 0.6],
  [61, '1AVJKwzs9AskraJLGHAZPiaZcrpDr1U6AB', '0x13c96a3742f64906', 0.61],
  [62, '1Me6EfpwZK5kQziBwBfvLiHjaPGxCKLoJi', '0x363d541eb611abee', 0.62],
  [63, '1NpYjtLira16LfGbGwZJ5JbDPh3ai9bjf4', '0x7cce5efdaccf6808', 0.63],
  [64, '16jY7qLJnxb7CHZyqBP8qca9d51gAjyXQN', '0xf7051f27b09112d4', 0.64, '2022-09-10'],
  [65, '18ZMbwUFLMHoZBbfpCjUJQTCMCbktshgpe', '0x1a838b13505b26867', 0.65, '2023-04-12'],
  [66, '13zb1hQbWVsc2S7ZTZnP2G4undNNpdh5so', '0x2832ed74f2b5e35ee', 6.6, '2024-09-12'],
  [67, '1BY8GQbnueYofwSuFAT3USAhGjPrkxDdW9', '0x730fc235c1942c1ae', 6.7, '2025-02-21'],
  [68, '1MVDYgVaSN6iKKEsbzRUAYFrYJadLYZvvZ', '0xbebb3940cd0fc1491', 6.8, '2025-04-06'],
  [69, '19vkiEajfhuZ8bs8Zu2jgmC6oqZbWqhxhG', '0x101d83275fb2bc7e0c', 6.9, '2025-04-30'],
  [70, '19YZECXj3SxEZMoUeJ1yiPsw8xANe7M7QR', '0x349b84b6431a6c4ef1', 0.7, '2025-05-30'],
  [71, '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU', null, 7.1],
  [72, '1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR', null, 7.2],
  [73, '12VVRNPi4SJqUTsp6FmqDqY5sGosDtysn4', null, 7.3],
  [74, '1FWGcVDK3JGzCC3WtkYetULPszMaK2Jksv', null, 7.4],
  [75, '1J36UjUByGroXcCvmj13U6uwaVv9caEeAt', '0x4c5ce114686a1336e07', 0.75, '2019-06-10'],
  [76, '1DJh2eHFYQfACPmrvpyWc8MSTYKh7w9eRF', null, 7.6],
  [77, '1Bxk4CQdqL9p22JEtDfdXMsng1XacifUtE', null, 7.7],
  [78, '15qF6X51huDjqTmF9BJgxXdt1xcj46Jmhb', null, 7.8],
  [79, '1ARk8HWJMn8js8tQmGUJeQHjSE7KRkn2t8', null, 7.9],
  [80, '1BCf6rHUW6m3iH2ptsvnjgLruAiPQQepLe', '0xea1a5c66dcc11b5ad180', 0.8, '2019-05-31'],
  [81, '15qsCm78whspNQFydGJQk5rexzxTQopnHZ', null, 8.1],
  [82, '13zYrYhhJxp6Ui1VV7pqa5WDhNWM45ARAC', null, 8.2],
  [83, '14MdEb4eFcT3MVG5sPFG4jGLuHJSnt1Dk2', null, 8.3],
  [84, '1CMq3SvFcVEcpLMuuH8PUcNiqsK1oicG2D', null, 8.4],
  [85, '1Kh22PvXERd2xpTQk3ur6pPEqFeckCJfAr', '0x11720c4f018d51b8cebba8', 0.85, '2019-06-05'],
  [86, '1K3x5L6G57Y494fDqBfrojD28UJv4s5JcK', null, 8.6],
  [87, '1PxH3K1Shdjb7gSEoTX7UPDZ6SH4qGPrvq', null, 8.7],
  [88, '16AbnZjZZipwHMkYKBSfswGWKDmXHjEpSf', null, 8.8],
  [89, '19QciEHbGVNY4hrhfKXmcBBCrJSBZ6TaVt', null, 8.9],
  [90, '1L12FHH2FHjvTviyanuiFVfmzCy46RRATU', '0x2ce00bb2136a445c71e85bf', 0.9, '2019-06-06'],
  [91, '1EzVHtmbN4fs4MiNk3ppEnKKhsmXYJ4s74', null, 9.1],
  [92, '1AE8NzzgKE7Yhz7BWtAcAAxiFMbPo82NB5', null, 9.2],
  [93, '17Q7tuG2JwFFU9rXVj3uZqRtioH3mx2Jad', null, 9.3],
  [94, '1K6xGMUbs6ZTXBnhw1pippqwK6wjBWtNpL', null, 9.4],
  [95, '19eVSDuizydXxhohGh8Ki9WY9KsHdSwoQC', '0x527a792b183c7f64a0e8b1f4', 0.95, '2019-06-07'],
  [96, '15ANYzzCp5BFHcCnVFzXqyibpzgPLWaD8b', null, 9.6],
  [97, '18ywPwj39nGjqBrQJSzZVq2izR12MDpDr8', null, 9.7],
  [98, '1CaBVPrwUxbQYYswu32w7Mj4HR4maNoJSX', null, 9.8],
  [99, '1JWnE6p6UN7ZJBN7TtcbNDoRcjFtuDWoNL', null, 9.9],
  [100, '1KCgMv8fo2TPBpddVi9jqmMmcne9uSNJ5F', '0xaf55fc59c335c8ec67ed24826', 1, '2019-06-04'],
  [101, '1CKCVdbDJasYmhswB6HKZHEAnNaDpK7W4n', null, 10.1],
  [102, '1PXv28YxmYMaB8zxrKeZBW8dt2HK7RkRPX', null, 10.2],
  [103, '1AcAmB6jmtU6AiEcXkmiNE9TNVPsj9DULf', null, 10.3],
  [104, '1EQJvpsmhazYCcKX5Au6AZmZKRnzarMVZu', null, 10.4],
  [105, '1CMjscKB3QW7SDyQ4c3C3DEUHiHRhiZVib', '0x16f14fc2054cd87ee6396b33df3', 1.05, '2019-06-10'],
  [106, '18KsfuHuzQaBTNLASyj15hy4LuqPUo1FNB', null, 10.6],
  [107, '15EJFC5ZTs9nhsdvSUeBXjLAuYq3SWaxTc', null, 10.7],
  [108, '1HB1iKUqeffnVsvQsbpC6dNi1XKbyNuqao', null, 10.8],
  [109, '1GvgAXVCbA8FBjXfWiAms4ytFeJcKsoyhL', null, 10.9],
  [110, '12JzYkkN76xkwvcPT6AWKZtGX6w2LAgsJg', '0x35c0d7234df7deb0f20cf7062444', 1.1, '2019-07-04'],
  [111, '1824ZJQ7nKJ9QFTRBqn7z7dHV5EGpzUpH3', null, 11.1],
  [112, '18A7NA9FTsnJxWgkoFfPAFbQzuQxpRtCos', null, 11.2],
  [113, '1NeGn21dUDDeqFQ63xb2SpgUuXuBLA4WT4', null, 11.3],
  [114, '174SNxfqpdMGYy5YQcfLbSTK3MRNZEePoy', null, 11.4],
  [115, '1NLbHuJebVwUZ1XqDjsAyfTRUPwDQbemfv', '0x60f4d11574f5deee49961d9609ac6', 1.15, '2020-05-24'],
  [116, '1MnJ6hdhvK37VLmqcdEwqC3iFxyWH2PHUV', null, 11.6],
  [117, '1KNRfGWw7Q9Rmwsc6NT5zsdvEb9M2Wkj5Z', null, 11.7],
  [118, '1PJZPzvGX19a7twf5HyD2VvNiPdHLzm9F6', null, 11.8],
  [119, '1GuBBhf61rnvRe4K8zu8vdQB3kHzwFqSy7', null, 11.9],
  [120, '17s2b9ksz5y7abUm92cHwG8jEPCzK3dLnT', '0xb10f22572c497a836ea187f2e1fc23', 1.2, '2021-01-29'],
  [121, '1GDSuiThEV64c166LUFC9uDcVdGjqkxKyh', null, 12.1],
  [122, '1Me3ASYt5JCTAK2XaC32RMeH34PdprrfDx', null, 12.2],
  [123, '1CdufMQL892A69KXgv6UNBD17ywWqYpKut', null, 12.3],
  [124, '1BkkGsX9ZM6iwL3zbqs7HWBV7SvosR6m8N', null, 12.4],
  [125, '1PXAyUB8ZoH3WD8n5zoAthYjN15yN5CVq5', '0x1c533b6bb7f0804e09960225e44877ac', 12.5, '2023-07-09'],
  [126, '1AWCLZAjKbV1P7AHvaPNCKiB7ZWVDMxFiz', null, 12.6],
  [127, '1G6EFyBRU86sThN3SSt3GrHu1sA7w7nzi4', null, 12.7],
  [128, '1MZ2L1gFrCtkkn6DnTT2e4PFUTHw9gNwaj', null, 12.8],
  [129, '1Hz3uv3nNZzBVMXLGadCucgjiCs5W9vaGz', null, 12.9],
  [130, '1Fo65aKq8s8iquMt6weF1rku1moWVEd5Ua', '0x33e7665705359f04f28b88cf897c603c9', 13, '2024-09-23'],
  [131, '16zRPnT8znwq42q7XeMkZUhb1bKqgRogyy', null, 13.1],
  [132, '1KrU4dHE5WrW8rhWDsTRjR21r8t3dsrS3R', null, 13.2],
  [133, '17uDfp5r4n441xkgLFmhNoSW1KWp6xVLD', null, 13.3],
  [134, '13A3JrvXmvg5w9XGvyyR4JEJqiLz8ZySY3', null, 13.4],
  [135, '16RGFo6hjq9ym6Pj7N5H7L1NR1rVPJyw2v', '0x6d9392a16883f90903d5f78da57af07eb2', 13.5, '2026-07-28'],
  [136, '1UDHPdovvR985NrWSkdWQDEQ1xuRiTALq', null, 13.6],
  [137, '15nf31J46iLuK1ZkTnqHo7WgN5cARFK3RA', null, 13.7],
  [138, '1Ab4vzG6wEQBDNQM1B2bvUz4fqXXdFk2WT', null, 13.8],
  [139, '1Fz63c775VV9fNyj25d9Xfw3YHE6sKCxbt', null, 13.9],
  [140, '1QKBaU6WAeycb3DbKbLBkX7vJiaS8r42Xo', null, 14],
  [141, '1CD91Vm97mLQvXhrnoMChhJx4TP9MaQkJo', null, 14.1],
  [142, '15MnK2jXPqTMURX4xC3h4mAZxyCcaWWEDD', null, 14.2],
  [143, '13N66gCzWWHEZBxhVxG18P8wyjEWF9Yoi1', null, 14.3],
  [144, '1NevxKDYuDcCh1ZMMi6ftmWwGrZKC6j7Ux', null, 14.4],
  [145, '19GpszRNUej5yYqxXoLnbZWKew3KdVLkXg', null, 14.5],
  [146, '1M7ipcdYHey2Y5RZM34MBbpugghmjaV89P', null, 14.6],
  [147, '18aNhurEAJsw6BAgtANpexk5ob1aGTwSeL', null, 14.7],
  [148, '1FwZXt6EpRT7Fkndzv6K4b4DFoT4trbMrV', null, 14.8],
  [149, '1CXvTzR6qv8wJ7eprzUKeWxyGcHwDYP1i2', null, 14.9],
  [150, '1MUJSJYtGPVGkBCTqGspnxyHahpt5Te8jy', null, 15],
  [151, '13Q84TNNvgcL3HJiqQPvyBb9m4hxjS3jkV', null, 15.1],
  [152, '1LuUHyrQr8PKSvbcY1v1PiuGuqFjWpDumN', null, 15.2],
  [153, '18192XpzzdDi2K11QVHR7td2HcPS6Qs5vg', null, 15.3],
  [154, '1NgVmsCCJaKLzGyKLFJfVequnFW9ZvnMLN', null, 15.4],
  [155, '1AoeP37TmHdFh8uN72fu9AqgtLrUwcv2wJ', null, 15.5],
  [156, '1FTpAbQa4h8trvhQXjXnmNhqdiGBd1oraE', null, 15.6],
  [157, '14JHoRAdmJg3XR4RjMDh6Wed6ft6hzbQe9', null, 15.7],
  [158, '19z6waranEf8CcP8FqNgdwUe1QRxvUNKBG', null, 15.8],
  [159, '14u4nA5sugaswb6SZgn5av2vuChdMnD9E5', null, 15.9],
  [160, '1NBC8uXJy1GiJ6drkiZa1WuKn51ps7EPTv', null, 16],
];

function computeSolvedPercent(bits: number, solvedKeyHex: string): number {
  if (bits <= 1) return 0;
  const min = 1n << BigInt(bits - 1);
  const max = (1n << BigInt(bits)) - 1n;
  const key = BigInt(solvedKeyHex);
  const span = max - min + 1n;
  const scaled = ((key - min) * 10_000n) / span;
  return Number(scaled) / 100;
}

function buildPuzzleNotes(
  bits: number,
  status: BitcoinPuzzleStatus,
  pubkeyExposed: boolean,
  rewardBtc: number,
): { note: string; noteCs: string } {
  if (status === 'active') {
    return {
      note: 'Active lowest-bit Hash160 target (7.10 BTC). No public key has been exposed on-chain.',
      noteCs:
        'Aktivní nejnižší Hash160 cíl výzvy (7,10 BTC). Veřejný klíč nebyl na blockchainu odhalen.',
    };
  }
  if (bits === 125) {
    return {
      note: 'First 10x-boosted exposed-pubkey puzzle solved (12.50 BTC) in July 2023.',
      noteCs: 'První vyřešené 10× navýšené puzzle s odhaleným klíčem (12,50 BTC) v červenci 2023.',
    };
  }
  if (bits === 130) {
    return {
      note: 'Solved via GPU Pollard’s Kangaroo in September 2024 for 13.00 BTC.',
      noteCs: 'Vyřešeno GPU algoritmem Kangaroo v září 2024 s odměnou 13,00 BTC.',
    };
  }
  if (bits === 135) {
    return {
      note: 'Solved in July 2026 via GPU Kangaroo (RCKangaroo) for 13.50 BTC.',
      noteCs: 'Vyřešeno v červenci 2026 pomocí GPU Kangaroo (RCKangaroo) s odměnou 13,50 BTC.',
    };
  }
  if (status === 'solved' && pubkeyExposed) {
    return {
      note: 'Public key was exposed in 2019 and solved using Pollard’s Kangaroo.',
      noteCs: 'Veřejný klíč byl zveřejněn v roce 2019 a úroveň byla vyřešena metodou Kangaroo.',
    };
  }
  if (status === 'solved') {
    const formattedBtc = rewardBtc.toFixed(rewardBtc < 1 ? 3 : 2);
    return {
      note: `Private key solved and claimed (${formattedBtc} BTC).`,
      noteCs: `Privátní klíč vyřešen a vyplacen (${formattedBtc.replace('.', ',')} BTC).`,
    };
  }
  if (pubkeyExposed) {
    return {
      note: 'Public key exposed since 2019 — vulnerable to O(√N) Pollard’s Kangaroo solvers.',
      noteCs: 'Veřejný klíč je odhalen od roku 2019 — zranitelné O(√N) algoritmem Pollardovo Kangaroo.',
    };
  }
  return {
    note: 'Shielded behind Hash160 — requires direct secp256k1 + Hash160 brute-force scanning.',
    noteCs: 'Skryté pod Hash160 — vyžaduje přímé hrubé prohledávání secp256k1 + Hash160.',
  };
}

export const BITCOIN_PUZZLE_LIST: readonly BitcoinPuzzleRecord[] = RAW_PUZZLES.map(
  ([bits, address, solvedKeyHex, rewardBtc, solvedDate]) => {
    const min = 1n << BigInt(bits - 1);
    const max = (1n << BigInt(bits)) - 1n;
    const status: BitcoinPuzzleStatus = solvedKeyHex
      ? 'solved'
      : bits === 71
        ? 'active'
        : 'unsolved';
    const pubkeyExposed = bits >= 75 && bits % 5 === 0;
    const { note, noteCs } = buildPuzzleNotes(bits, status, pubkeyExposed, rewardBtc);

    return {
      bits,
      address,
      hexStart: `0x${min.toString(16)}`,
      hexEnd: `0x${max.toString(16)}`,
      rewardBtc,
      status,
      pubkeyExposed,
      ...(solvedKeyHex
        ? {
            solvedKeyHex,
            solvedPercent: computeSolvedPercent(bits, solvedKeyHex),
            ...(solvedDate ? { solvedDate } : {}),
          }
        : {}),
      note,
      noteCs,
    };
  },
);

const solvedPuzzles = BITCOIN_PUZZLE_LIST.filter((p) => p.status === 'solved');
const unsolvedPuzzles = BITCOIN_PUZZLE_LIST.filter((p) => p.status !== 'solved');
const solvedBtcSum = Number(
  solvedPuzzles.reduce((sum, p) => sum + p.rewardBtc, 0).toFixed(3),
);
const remainingBtcSum = Number(
  unsolvedPuzzles.reduce((sum, p) => sum + p.rewardBtc, 0).toFixed(3),
);
const totalSeriesBtcSum = Number((solvedBtcSum + remainingBtcSum).toFixed(3));
const avgPercent =
  solvedPuzzles.length > 0
    ? Number(
        (
          solvedPuzzles.reduce((sum, p) => sum + (p.solvedPercent ?? 0), 0) / solvedPuzzles.length
        ).toFixed(2),
      )
    : 0;

export const BITCOIN_PUZZLE_CHALLENGE_SUMMARY = {
  creatorAlias: 'saatoshi_rising',
  createdDate: '2015-01-15',
  totalPuzzles: BITCOIN_PUZZLE_LIST.length,
  solvedCount: solvedPuzzles.length,
  unsolvedCount: unsolvedPuzzles.length,
  solvedBtc: solvedBtcSum,
  remainingBtc: remainingBtcSum,
  totalSeriesBtc: totalSeriesBtcSum,
  exposedUnsolvedCount: unsolvedPuzzles.filter((p) => p.pubkeyExposed).length,
  averageFoundPercent: avgPercent,
} as const;

export function formatBitRangeLabel(bits: number): string {
  if (bits <= 1) return '2⁰ (1)';
  return `2^${bits - 1} → 2^${bits}−1`;
}

export function getPuzzleNote(puzzle: BitcoinPuzzleRecord, locale: Locale): string {
  return locale === 'cs' ? puzzle.noteCs : puzzle.note;
}

export function calculatePuzzleOddsAndEta(params: {
  bitWidth: number;
  keysPerSec: number;
}): {
  bits: number;
  totalKeysFloat: number;
  blockCount: number;
  fitsInsideSingleBlock: boolean;
  effectiveBlockKeys: number;
  secondsPerBlock: number;
  medianSeconds50Pct: number;
  fullSeconds100Pct: number;
  kangarooOpsEstimate: number;
  kangarooSecondsEstimate: number;
} {
  const bits = Math.max(1, Math.min(160, Math.floor(params.bitWidth)));
  const totalKeysFloat = Math.pow(2, bits - 1);
  const blockSizeFloat = Number(BLOCK_SIZE);
  const fitsInsideSingleBlock = totalKeysFloat <= blockSizeFloat;
  const effectiveBlockKeys = fitsInsideSingleBlock ? totalKeysFloat : blockSizeFloat;
  const blockCount = fitsInsideSingleBlock ? 1 : Math.round(totalKeysFloat / blockSizeFloat);
  const rate = Number.isFinite(params.keysPerSec) && params.keysPerSec > 0 ? params.keysPerSec : 0;

  const secondsPerBlock = rate > 0 ? effectiveBlockKeys / rate : 0;
  const fullSeconds100Pct = rate > 0 ? totalKeysFloat / rate : 0;
  const medianSeconds50Pct = fullSeconds100Pct / 2;
  const kangarooOpsEstimate = Math.sqrt(totalKeysFloat);
  const kangarooSecondsEstimate = rate > 0 ? kangarooOpsEstimate / rate : 0;

  return {
    bits,
    totalKeysFloat,
    blockCount,
    fitsInsideSingleBlock,
    effectiveBlockKeys,
    secondsPerBlock,
    medianSeconds50Pct,
    fullSeconds100Pct,
    kangarooOpsEstimate,
    kangarooSecondsEstimate,
  };
}

export function getBitcoinPuzzleTimeline(
  locale: Locale,
): Array<{ date: string; title: string; description: string }> {
  if (locale === 'cs') {
    return [
      {
        date: '2015-01-15',
        title: 'Vytvoření série 160 adres (saatoshi_rising)',
        description:
          'Anonymní tvůrce zveřejnil bitcoinovou transakci s 256 (později konsolidovanými 160) výstupy se stoupající bitovou entropií od 1 do 160 bitů.',
      },
      {
        date: '2019-05 → 2021-01',
        title: 'Milníky #75–#120 prolomeny metodou Kangaroo',
        description:
          'U každé 5. úrovně došlo k odhalení veřejného klíče odchozí transakcí; specializované ECDLP řešiče snížily složitost z O(N) na O(√N).',
      },
      {
        date: '2023-04-16',
        title: 'Desetinásobné navýšení zbývajících odměn',
        description:
          'Tvůrce poslal dodatečné prostředky na nevyřešené adresy (#66–#160) a zvýšil odměny na 6,6 až 16,0 BTC (Puzzle #71 stouplo na 7,10 BTC).',
      },
      {
        date: '2023-07 → 2026-07',
        title: 'Vyřešení #66–#70 a #125–#135 (včetně 13,50 BTC)',
        description:
          'Hrubou silou na GPU byly postupně nalezeny úrovně #66 až #70 a pomocí RCKangaroo i #125, #130 a #135 — nejnižším aktivním Hash160 cílem zůstává #71.',
      },
    ];
  }

  return [
    {
      date: '2015-01-15',
      title: '160-Address Challenge Created (saatoshi_rising)',
      description:
        'An anonymous creator funded deterministic keys spanning 1-bit through 160-bit ranges as a public demonstration of Bitcoin secp256k1 keyspace security.',
    },
    {
      date: '2019-05 → 2021-01',
      title: 'Exposed PubKey Milestones #75–#120 Cracked',
      description:
        'Every 5th puzzle from #75 upward had an on-chain outgoing spend exposing its public key, enabling O(√N) Pollard’s Kangaroo attacks.',
    },
    {
      date: '2023-04-16',
      title: '10× Bounty Boost Across Unsolved Levels',
      description:
        'The creator topped up all remaining unsolved puzzles (#66–#160), lifting rewards to 6.60–16.00 BTC (Puzzle #71 rose to 7.10 BTC).',
    },
    {
      date: '2023-07 → 2026-07',
      title: '#66–#70 & #125–#135 Claimed — #71 Now Primary Target',
      description:
        'GPU brute-force pools cleared #66–#70 while GPU Kangaroo solved #125, #130, and #135, leaving Puzzle #71 (7.10 BTC) as the lowest unsolved Hash160 level.',
    },
  ];
}
