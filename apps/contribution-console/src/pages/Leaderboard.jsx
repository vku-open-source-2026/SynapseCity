import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../services/apiClient';
import { SiteHeader } from '../components/UI/SiteHeader';

const DEFAULT_UNIT = 'VKU';
const ALL_ORGANIZATIONS = '';

const getLeaderUnit = (leader) => {
    const unit = typeof leader?.unit === 'string' ? leader.unit.trim() : '';
    return unit || DEFAULT_UNIT;
};

export function Leaderboard() {
    const [leaders, setLeaders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedUnit, setSelectedUnit] = useState(ALL_ORGANIZATIONS);

    useEffect(() => {
        const fetchLeaderboard = async () => {
            try {
                const response = await apiClient.get('/api/leaderboard');
                setLeaders(Array.isArray(response.data) ? response.data : []);
            } catch (error) {
                console.error("Error fetching leaderboard:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchLeaderboard();
    }, []);

    const organizations = useMemo(
        () => Array.from(new Set(leaders.map(getLeaderUnit))).sort((a, b) => a.localeCompare(b, 'vi')),
        [leaders]
    );

    const filteredLeaders = useMemo(
        () => selectedUnit === ALL_ORGANIZATIONS
            ? leaders
            : leaders.filter((leader) => getLeaderUnit(leader) === selectedUnit),
        [leaders, selectedUnit]
    );

    const topThree = filteredLeaders.slice(0, 3);

    const getRankIcon = (rank) => {
        switch(rank) {
            case 1: return "🥇";
            case 2: return "🥈";
            case 3: return "🥉";
            default: return rank;
        }
    };

    return (
        <div className="page">
            <SiteHeader subtitle="Bảng xếp hạng đóng góp" />
            <div className="app-container">
            <div className="leaderboard-content">
                <div className="leaderboard-header">
                    <Link to="/" className="back-btn">← Back to Map</Link>
                    <h1>🏆 Top Contributors</h1>
                    <p>
                        Cảm ơn rất nhiều vì các bạn đã bỏ thời gian công sức quý báu ra để đóng góp dữ liệu cho dự án <br/>
                        

                    </p>
                </div>

                {loading ? (
                    <div className="loading-spinner">Loading...</div>
                ) : (
                    <>
                        <div className="leaderboard-filter">
                            <label htmlFor="leaderboard-unit">Lọc theo tổ chức</label>
                            <select
                                id="leaderboard-unit"
                                value={selectedUnit}
                                onChange={(event) => setSelectedUnit(event.target.value)}
                                disabled={organizations.length === 0}
                            >
                                <option value={ALL_ORGANIZATIONS}>Tất cả tổ chức</option>
                                {organizations.map((unit) => (
                                    <option key={unit} value={unit}>{unit}</option>
                                ))}
                            </select>
                        </div>
                        <p className="leaderboard-summary" role="status" aria-live="polite">
                            {filteredLeaders.length} người đóng góp
                            {selectedUnit !== ALL_ORGANIZATIONS ? ` tại ${selectedUnit}` : ''}
                        </p>

                        {topThree.length > 0 && (
                            <section className="podium" aria-label="Top 3 người đóng góp">
                                {topThree.map((leader, index) => {
                                    const rank = index + 1;
                                    return (
                                        <article key={leader.msv || `${getLeaderUnit(leader)}-${index}`} className={`podium-card rank-${rank}`}>
                                            <span className="podium-medal" role="img" aria-label={`Hạng ${rank}`}>
                                                {getRankIcon(rank)}
                                            </span>
                                            <div className="podium-name">{leader.contributor_name}</div>
                                            <div className="podium-sub">{leader.msv} · {getLeaderUnit(leader)}</div>
                                            <div className="podium-points">
                                                {leader.count} <span>điểm</span>
                                            </div>
                                        </article>
                                    );
                                })}
                            </section>
                        )}

                        <div className="leaderboard-card">
                            {leaders.length === 0 ? (
                                <div className="empty-state">
                                    <p>Chưa có đóng góp nào. Hãy là người đầu tiên!</p>
                                    <Link to="/" className="contribute-btn">Start Mapping</Link>
                                </div>
                            ) : filteredLeaders.length === 0 ? (
                                <div className="empty-state">
                                    <p>Chưa có đóng góp nào cho tổ chức <strong>{selectedUnit}</strong>.</p>
                                    <button
                                        type="button"
                                        className="contribute-btn"
                                        onClick={() => setSelectedUnit(ALL_ORGANIZATIONS)}
                                    >
                                        Xem tất cả tổ chức
                                    </button>
                                </div>
                            ) : (
                                <table
                                    className="leaderboard-table"
                                    aria-label={selectedUnit === ALL_ORGANIZATIONS
                                        ? 'Bảng xếp hạng tất cả tổ chức'
                                        : `Bảng xếp hạng tổ chức ${selectedUnit}`}
                                >
                                    <thead>
                                        <tr>
                                            <th scope="col" style={{width: '100px', textAlign: 'center'}}>Rank</th>
                                            <th scope="col">Contributor</th>
                                            <th scope="col" style={{textAlign: 'right'}}>Points</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredLeaders.map((leader, index) => {
                                            const rank = index + 1;
                                            return (
                                                <tr key={leader.msv || `${getLeaderUnit(leader)}-${index}`} className={`rank-row rank-${rank}`}>
                                                    <td className="rank-cell">
                                                        <span className={`rank-badge rank-${rank}`} role="img" aria-label={`Hạng ${rank}`}>
                                                            {getRankIcon(rank)}
                                                        </span>
                                                    </td>
                                                    <td className="name-cell">
                                                        <div className="contributor-info">
                                                            <span className="name">{leader.contributor_name}</span>
                                                            <span className="msv">{leader.msv}</span>
                                                            <span className="unit">{getLeaderUnit(leader)}</span>
                                                        </div>
                                                    </td>
                                                    <td className="count-cell">{leader.count}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </>
                )}
            </div>
            </div>
        </div>
    );
}
